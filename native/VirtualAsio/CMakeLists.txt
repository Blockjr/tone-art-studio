# Tone Art Virtual ASIO: a user-mode COM DLL, no JUCE, no kernel driver.
# Only valid on Windows; the parent CMakeLists guards the add_subdirectory call.

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
add_custom_command(TARGET HybridVirtualAsio POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "$<TARGET_FILE:HybridVirtualAsio>"
          "$<TARGET_FILE_DIR:HybridStudio>/HybridVirtualAsio.dll"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${CMAKE_CURRENT_SOURCE_DIR}/install.ps1"
          "$<TARGET_FILE_DIR:HybridStudio>/install-virtual-asio.ps1"
  COMMENT "Copying the virtual ASIO driver into the application folder"
)
