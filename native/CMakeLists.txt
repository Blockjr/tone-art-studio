cmake_minimum_required(VERSION 3.25)

# JUCE 9 refuses to configure without a C compiler (its bundled libraries use it).
project(HybridStudio VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")

option(HYBRID_BUILD_VIRTUAL_ASIO "Build the Tone Art Virtual ASIO driver DLL" OFF)
option(HYBRID_BUILD_GATE_VST3 "Build the bundled Tone Art Gate VST3 plugin" ON)

include(FetchContent)

# JUCE 9 is current; 8.0.16 works too. Change both the tag and the docs if you pin.
FetchContent_Declare(
  JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 9.0.4
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(JUCE)

set(HYBRID_APP_OPTIONS "")
if(WIN32)
  list(APPEND HYBRID_APP_OPTIONS NEEDS_WEBVIEW2 TRUE)

  # The same mark Windows shows in the taskbar, the title bar, Alt-Tab,
  # Explorer, the shortcut and the installer. JUCE's ICON_BIG must be an image
  # its Drawable loader understands (PNG here), not an .ico: juceaide turns it
  # into the multi-resolution icon the executable carries.
  set(HYBRID_ICON_PNG "${CMAKE_CURRENT_SOURCE_DIR}/../assets/brand/tone-art-1024.png")
  if(EXISTS "${HYBRID_ICON_PNG}")
    list(APPEND HYBRID_APP_OPTIONS ICON_BIG "${HYBRID_ICON_PNG}")
  else()
    message(STATUS "App icon not found at ${HYBRID_ICON_PNG}; the executable will use the default JUCE icon.\n"
                   "Generate it with: python3 assets/brand/generate-icons.py")
  endif()
endif()

juce_add_gui_app(HybridStudio
  PRODUCT_NAME "Tone Art Studio"
  COMPANY_NAME "Tone Art Studio"
  BUNDLE_ID "com.toneartstudio.app"
  VERSION ${PROJECT_VERSION}
  ${HYBRID_APP_OPTIONS}
)

juce_generate_juce_header(HybridStudio)

target_sources(HybridStudio PRIVATE
  Source/Main.cpp
  Source/MainComponent.cpp
  Source/AudioEngine.cpp
  Source/PluginHost.cpp
  Source/PluginWindow.cpp
  Source/VirtualAsioPeer.cpp
  Source/VstInsert.cpp
  Source/VstScanner.cpp
  Core/MixGraph.cpp
  Core/SongPlayer.cpp
)

target_include_directories(HybridStudio PRIVATE Source Core)

target_compile_definitions(HybridStudio PRIVATE
  JUCE_WEB_BROWSER=1
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_VST=0
  JUCE_PLUGINHOST_AU=0
  JUCE_MODAL_LOOPS_PERMITTED=1
  JUCE_DISPLAY_SPLASH_SCREEN=0
  JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:HybridStudio,JUCE_PRODUCT_NAME>"
  JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:HybridStudio,JUCE_VERSION>"
)

if(WIN32)
  # ASIO hosting (the Steinberg ASIO SDK is a JUCE submodule; its licence still
  # applies to shipping binaries) and the Chromium WebView2 backend for the UI.
  target_compile_definitions(HybridStudio PRIVATE
    JUCE_ASIO=1
    JUCE_USE_WIN_WEBVIEW2=1
  )
else()
  message(STATUS "ASIO and WebView2 are Windows-only; building for ${CMAKE_SYSTEM_NAME} without them.")
endif()

target_link_libraries(HybridStudio PRIVATE
  juce::juce_audio_utils
  juce::juce_audio_processors
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_dsp
  juce::juce_gui_extra
  juce::juce_gui_basics
  PUBLIC
  juce::juce_recommended_config_flags
  juce::juce_recommended_lto_flags
)

# Ship the built web UI next to the executable: copy dist/ into <artefacts>/ui.
set(HYBRID_UI_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/../dist")
if(EXISTS "${HYBRID_UI_SOURCE}/index.html")
  add_custom_command(TARGET HybridStudio POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${HYBRID_UI_SOURCE}"
            "$<TARGET_FILE_DIR:HybridStudio>/ui"
    COMMENT "Copying web UI into the application folder")
else()
  message(STATUS "dist/ not found - build the web UI first (npm run build). The host will fall back to http://localhost:3000.")
endif()

# --------------------------------------------------------------- the plugin
# Tone Art Gate is a real VST3, built from the same project: the desktop host
# can load it from the standard VST3 folder like any third-party plugin, and so
# can any other DAW. Installer copies it to {commoncf}\VST3.

if(HYBRID_BUILD_GATE_VST3)
  juce_add_plugin(ToneArtGate
    PRODUCT_NAME "Tone Art Gate"
    COMPANY_NAME "Tone Art Studio"
    BUNDLE_ID "com.toneartstudio.gate"
    PLUGIN_MANUFACTURER_CODE TArt
    PLUGIN_CODE Gate
    FORMATS VST3
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    VST3_CATEGORIES Fx
  )

  target_sources(ToneArtGate PRIVATE
    Plugins/ToneArtGate/PluginProcessor.cpp
    Plugins/ToneArtGate/PluginEditor.cpp
  )

  target_include_directories(ToneArtGate PRIVATE Plugins/ToneArtGate)
  juce_generate_juce_header(ToneArtGate)

  target_compile_definitions(ToneArtGate PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:ToneArtGate,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:ToneArtGate,JUCE_VERSION>"
  )

  target_link_libraries(ToneArtGate PRIVATE
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_dsp
    juce::juce_gui_extra
    juce::juce_gui_basics
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
  )
endif()

if(HYBRID_BUILD_VIRTUAL_ASIO)
  if(WIN32)
    add_subdirectory(VirtualAsio)
  else()
    message(STATUS "HYBRID_BUILD_VIRTUAL_ASIO is Windows-only; ignoring on ${CMAKE_SYSTEM_NAME}.")
  endif()
endif()
