cmake_minimum_required(VERSION 4.0)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

project(pear_vanity_gpu C CXX)

# Match the static C runtime of the official libsodium MSVC build and avoid a
# Visual C++ redistributable dependency.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_bare_module(pear_vanity_gpu)

# Vulkan is loaded at run time, so only its headers and a GLSL compiler are needed.
find_path(VULKAN_INCLUDE_DIR vulkan/vulkan.h HINTS ENV VULKAN_SDK PATH_SUFFIXES include
  REQUIRED)
find_program(GLSLANG_VALIDATOR NAMES glslangValidator glslang HINTS ENV VULKAN_SDK
  PATH_SUFFIXES bin REQUIRED)
find_path(SODIUM_INCLUDE_DIR sodium.h REQUIRED)
find_path(OPENCL_INCLUDE_DIR CL/cl.h REQUIRED)

option(VANITY_STATIC_SODIUM "Link libsodium into release addons" ON)

if(VANITY_STATIC_SODIUM AND UNIX)
  set(SAVED_LIBRARY_SUFFIXES ${CMAKE_FIND_LIBRARY_SUFFIXES})
  set(CMAKE_FIND_LIBRARY_SUFFIXES .a)
  find_library(SODIUM_LIBRARY sodium REQUIRED)
  set(CMAKE_FIND_LIBRARY_SUFFIXES ${SAVED_LIBRARY_SUFFIXES})
else()
  find_library(SODIUM_LIBRARY sodium REQUIRED)
endif()

# node_modules/.bin only holds shell and .cmd shims on Windows, so prefer the
# platform runtime package's executable there.
find_program(
  BARE_EXECUTABLE bare
  HINTS
    "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/bare-runtime-win32-x64/bin"
    "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/bare-runtime-win32-arm64/bin"
    "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/.bin"
  REQUIRED
)

add_custom_command(
  OUTPUT
    ${CMAKE_CURRENT_BINARY_DIR}/basepoint-table.h
    ${CMAKE_CURRENT_BINARY_DIR}/field.glsl
  COMMAND
    ${BARE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/native/generate-table.js
    ${CMAKE_CURRENT_BINARY_DIR}/basepoint-table.h
    ${CMAKE_CURRENT_BINARY_DIR}/field.glsl
  DEPENDS native/generate-table.js
  VERBATIM
)

add_custom_command(
  OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/kernel.h
  COMMAND
    ${BARE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/native/generate-kernel.js
    ${CMAKE_CURRENT_SOURCE_DIR}/native/search.comp
    ${CMAKE_CURRENT_BINARY_DIR}/field.glsl
    ${CMAKE_CURRENT_BINARY_DIR}/kernel.h
  DEPENDS
    native/generate-kernel.js
    native/search.comp
    ${CMAKE_CURRENT_BINARY_DIR}/field.glsl
  VERBATIM
)

set(GENERATED_HEADERS ${CMAKE_CURRENT_BINARY_DIR}/kernel.h)
foreach(MODE IN ITEMS touch multisig)
  if(MODE STREQUAL "touch")
    set(TOUCH 1)
  else()
    set(TOUCH 0)
  endif()
  add_custom_command(
    OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/${MODE}.h
    COMMAND
      ${GLSLANG_VALIDATOR} -V --target-env vulkan1.1 -DTOUCH=${TOUCH}
      -I${CMAKE_CURRENT_BINARY_DIR} --vn ${MODE}_shader
      -o ${CMAKE_CURRENT_BINARY_DIR}/${MODE}.h
      ${CMAKE_CURRENT_SOURCE_DIR}/native/search.comp
    DEPENDS native/search.comp ${CMAKE_CURRENT_BINARY_DIR}/field.glsl
    VERBATIM
  )
  list(APPEND GENERATED_HEADERS ${CMAKE_CURRENT_BINARY_DIR}/${MODE}.h)
endforeach()

target_compile_features(${pear_vanity_gpu} PRIVATE cxx_std_17)

target_sources(
  ${pear_vanity_gpu}
  PRIVATE
    binding.cc
    ${GENERATED_HEADERS}
    ${CMAKE_CURRENT_BINARY_DIR}/basepoint-table.h
)

target_include_directories(
  ${pear_vanity_gpu}
  PRIVATE
    ${CMAKE_CURRENT_BINARY_DIR}
    ${VULKAN_INCLUDE_DIR}
    ${SODIUM_INCLUDE_DIR}
    ${OPENCL_INCLUDE_DIR}
)

target_link_libraries(
  ${pear_vanity_gpu}
  PRIVATE
    ${SODIUM_LIBRARY}
    ${CMAKE_DL_LIBS}
)

if(WIN32 AND VANITY_STATIC_SODIUM)
  set(SODIUM_DEFINITIONS SODIUM_STATIC=1 SODIUM_EXPORT=)
  target_compile_definitions(${pear_vanity_gpu} PRIVATE ${SODIUM_DEFINITIONS})
endif()

if(UNIX AND NOT APPLE)
  target_link_options(${pear_vanity_gpu} INTERFACE -static-libstdc++ -static-libgcc)
endif()

option(VANITY_TESTS "Build native cryptographic regression tests" OFF)

if(VANITY_TESTS)
  enable_testing()
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  add_executable(vanity_crypto_test test/native.cc ${GENERATED_HEADERS}
    ${CMAKE_CURRENT_BINARY_DIR}/basepoint-table.h)
  target_compile_features(vanity_crypto_test PRIVATE cxx_std_17)
  target_include_directories(vanity_crypto_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_BINARY_DIR} ${VULKAN_INCLUDE_DIR} ${SODIUM_INCLUDE_DIR}
    ${OPENCL_INCLUDE_DIR})
  target_compile_definitions(vanity_crypto_test PRIVATE ${SODIUM_DEFINITIONS})
  target_link_libraries(vanity_crypto_test PRIVATE ${SODIUM_LIBRARY} ${CMAKE_DL_LIBS})
  if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(vanity_crypto_test PRIVATE -fsanitize=undefined
      -fno-sanitize-recover=all)
    target_link_options(vanity_crypto_test PRIVATE -fsanitize=undefined)
  endif()
  add_test(NAME crypto COMMAND vanity_crypto_test)
  if(NOT MSVC)
    # Builds a host shared library with c++ and UBSan.
    add_test(NAME field COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test/field.py)
    set_tests_properties(field PROPERTIES ENVIRONMENT "VANITY_BUILD_DIR=${CMAKE_CURRENT_BINARY_DIR}")
  endif()
  if(UNIX AND NOT APPLE)
    # GPU runtimes must be loaded on demand, never linked or left undefined.
    add_test(NAME runtime-linkage COMMAND sh ${CMAKE_CURRENT_SOURCE_DIR}/scripts/check-linkage.sh
      $<TARGET_FILE:${pear_vanity_gpu}_module>)
  endif()
endif()
