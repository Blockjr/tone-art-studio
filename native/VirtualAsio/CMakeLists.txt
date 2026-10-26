# Tone Art Virtual ASIO: a user-mode COM DLL, no JUCE, no kernel driver.
# Only valid on Windows; the parent CMakeLists guards the add_subdirectory call.
#
# This directory also configures on its own, which is how CI compiles and runs the
# bridge self-test in about a minute instead of building all of JUCE to find out
# whether the loopback still works:
#
#   cmake -S native/VirtualAsio -B build-asio -DASIO_SDK_DIR=<asio sdk root>
#   cmake --build build-asio --config Release
#   build-asio/Release/ToneArtVirtualAsioTest.exe

# Standalone, PROJECT_VERSION comes from nowhere and the policy version has not
# been set above either. Inside the full build the parent has done both. Read the
# version from package.json here too, so a standalone configure cannot stamp the
# driver with a version of its own (it used to say 0.1.0).
if(NOT PROJECT_VERSION)
  cmake_minimum_required(VERSION 3.25)

  set(_hybrid_version "0.0.0")
  set(_hybrid_package_json "${CMAKE_CURRENT_SOURCE_DIR}/../../package.json")
  if(EXISTS "${_hybrid_package_json}")
    file(READ "${_hybrid_package_json}" _hybrid_package_contents)
    string(REGEX MATCH "\"version\"[ ]*:[ ]*\"([0-9]+\\.[0-9]+\\.[0-9]+)\""
           _hybrid_version_match "${_hybrid_package_contents}")
    if(CMAKE_MATCH_1)
      set(_hybrid_version "${CMAKE_MATCH_1}")
    endif()
  endif()

  project(HybridVirtualAsioStandalone VERSION ${_hybrid_version} LANGUAGES CXX)
endif()

# Everything here is C++20: the shared block is inline constexpr and std::atomic,
# and the driver leans on if constexpr. The parent build sets this for the whole
# project; configured on its own, this file is the only chance to say so, and
# MSVC otherwise falls back to C++14 and refuses to compile the headers.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# JUCE 9 vendors the ASIO SDK straight into modules/juce_audio_devices/native/asio
# (no submodule, no 'common' subdirectory); JUCE 8 keeps it in ./asio/common.
# Both layouts, plus an SDK passed with -DASIO_SDK_DIR, are accepted.
find_path(HYBRID_ASIO_COMMON_DIR
  NAMES iasiodrv.h asiosys.h
  HINTS
    "${juce_SOURCE_DIR}/modules/juce_audio_devices/native/asio"
    "${juce_SOURCE_DIR}/modules/juce_audio_devices/native/asio/common"
    "${CMAKE_CURRENT_SOURCE_DIR}/external/asio/common"
    "$ENV{ASIO_SDK_DIR}/common"
    "${ASIO_SDK_DIR}/common"
    "${ASIO_SDK_DIR}"
  DOC "The Steinberg ASIO SDK header directory"
)

if(NOT HYBRID_ASIO_COMMON_DIR)
  # Do not fail the first configure: JUCE (and its ASIO submodule) only appears
  # after FetchContent has run. Fetch the headers, then configure again.
  message(WARNING
    "Skipping the virtual ASIO driver: Steinberg ASIO SDK headers not found.\n"
    "  The SDK lives in JUCE's asio submodule. From your build directory run:\n"
    "    git -C _deps/juce-src submodule update --init --recursive\n"
    "  or download the SDK from Steinberg and pass -DASIO_SDK_DIR=<sdk root>,\n"
    "  then configure again.")
  return()
endif()

message(STATUS "Virtual ASIO driver uses headers from ${HYBRID_ASIO_COMMON_DIR}")

add_library(HybridVirtualAsio SHARED
  VirtualAsioDriver.cpp
  DriverModule.cpp
  VirtualAsio.def
)

target_include_directories(HybridVirtualAsio PRIVATE
  "${HYBRID_ASIO_COMMON_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}/../Source"
)

target_compile_definitions(HybridVirtualAsio PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  UNICODE
  _UNICODE
)

if(MSVC)
  target_compile_options(HybridVirtualAsio PRIVATE /W4 /permissive- /EHsc)
  # A device driver DLL must not depend on a VC++ redistributable.
  set_property(TARGET HybridVirtualAsio PROPERTY
               MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

target_link_libraries(HybridVirtualAsio PRIVATE ole32)

set_target_properties(HybridVirtualAsio PROPERTIES
  PREFIX ""
  OUTPUT_NAME "HybridVirtualAsio"
  VERSION ${PROJECT_VERSION}
)

# Ship the DLL and its installer next to the application so the Studio Rig panel
# can point at a file the user can register.
if(TARGET HybridStudio)
  add_custom_command(TARGET HybridVirtualAsio POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:HybridVirtualAsio>"
            "$<TARGET_FILE_DIR:HybridStudio>/HybridVirtualAsio.dll"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_CURRENT_SOURCE_DIR}/install.ps1"
            "$<TARGET_FILE_DIR:HybridStudio>/install-virtual-asio.ps1"
    COMMENT "Copying the virtual ASIO driver into the application folder"
  )
endif()

# ------------------------------------------------------- the bridge self-test
# Exports and a COM class factory say nothing about whether the bridge between
# the driver and the studio carries audio. This program is the second application
# that bridge normally needs: it creates the driver in its own process, plays the
# studio's half of the shared block and accounts for every sample in both
# directions, so the whole path is exercised without a DAW, a sound card or an
# elevated session.
add_executable(HybridVirtualAsioTest self-test.cpp)

target_include_directories(HybridVirtualAsioTest PRIVATE
  "${HYBRID_ASIO_COMMON_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}/../Source"
)

target_compile_definitions(HybridVirtualAsioTest PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  UNICODE
  _UNICODE
)

if(MSVC)
  target_compile_options(HybridVirtualAsioTest PRIVATE /W4 /permissive- /EHsc)
  # Match the driver: no VC++ redistributable, so the pair can be copied to a
  # machine that has never seen Visual Studio.
  set_property(TARGET HybridVirtualAsioTest PROPERTY
               MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

target_link_libraries(HybridVirtualAsioTest PRIVATE ole32)

set_target_properties(HybridVirtualAsioTest PROPERTIES OUTPUT_NAME "ToneArtVirtualAsioTest")

# Next to the application, and therefore next to the driver: the self-test loads
# HybridVirtualAsio.dll from its own folder.
if(TARGET HybridStudio)
  add_custom_command(TARGET HybridVirtualAsioTest POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:HybridVirtualAsioTest>"
            "$<TARGET_FILE_DIR:HybridStudio>/ToneArtVirtualAsioTest.exe"
    COMMENT "Copying the virtual ASIO bridge self-test into the application folder"
  )
endif()
