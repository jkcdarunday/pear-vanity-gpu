#include "native/engine.h"
#include <bare.h>
#include <js.h>
#include <memory>

static void api(int status) {
  if (status != 0)
    throw std::runtime_error("Bare addon API failed");
}

static std::string string(js_env_t *env, js_value_t *value, size_t limit,
                          const char *description) {
  size_t length;
  api(js_get_value_string_utf8(env, value, nullptr, 0, &length));
  if (length > limit)
    throw std::runtime_error(std::string("Oversized ") + description);
  std::vector<utf8_t> data(length + 1);
  api(js_get_value_string_utf8(env, value, data.data(), data.size(), &length));
  return std::string(reinterpret_cast<char *>(data.data()), length);
}

static const js_type_tag_t handleTag = {0x8e6b11fca7354d29, 0xab721e9d42c380f6};

struct Handle {
  js_env_t *env;
  std::unique_ptr<Search> search;
  bool registered = false;
};

static void teardown(void *data) {
  auto handle = static_cast<Handle *>(data);
  handle->registered = false;
  handle->search.reset();
}

static void finalize(js_env_t *env, void *data, void *hint) {
  auto handle = static_cast<Handle *>(data);
  if (handle->registered)
    js_remove_teardown_callback(env, teardown, handle);
  delete handle;
}

static js_value_t *create(js_env_t *env, js_callback_info_t *info) {
  try {
    size_t argc = 6;
    js_value_t *args[6];
    api(js_get_callback_info(env, info, &argc, args, nullptr, nullptr));
    if (argc != 6)
      throw std::runtime_error("Invalid search arguments");
    auto input = string(env, args[0], 32768, "search configuration");
    auto backend = string(env, args[1], 16, "backend");
    auto cache = string(env, args[5], 4096, "cache directory");
    bool software;
    uint32_t batch, benchmark;
    api(js_get_value_bool(env, args[2], &software));
    api(js_get_value_uint32(env, args[3], &batch));
    api(js_get_value_uint32(env, args[4], &benchmark));
    js_value_t *result;
    api(js_create_object(env, &result));
    api(js_add_type_tag(env, result, &handleTag));
    auto handle = std::make_unique<Handle>();
    handle->env = env;
    handle->search =
        std::make_unique<Search>(input, backend, software, batch, benchmark, cache);
    api(js_add_teardown_callback(env, teardown, handle.get()));
    handle->registered = true;
    int status = js_wrap(env, result, handle.get(), finalize, nullptr, nullptr);
    if (status != 0) {
      js_remove_teardown_callback(env, teardown, handle.get());
      api(status);
    }
    handle.release();
    return result;
  } catch (const std::exception &e) {
    js_throw_error(env, "ERR_VANITY_GPU", e.what());
    return nullptr;
  }
}

static Handle *get(js_env_t *env, js_callback_info_t *info) {
  size_t argc = 1;
  js_value_t *args[1];
  api(js_get_callback_info(env, info, &argc, args, nullptr, nullptr));
  if (argc != 1)
    throw std::runtime_error("Missing search handle");
  js_value_type_t type;
  api(js_typeof(env, args[0], &type));
  if (type != js_object)
    throw std::runtime_error("Invalid search handle");
  bool valid;
  api(js_check_type_tag(env, args[0], &handleTag, &valid));
  if (!valid)
    throw std::runtime_error("Invalid search handle");
  void *data;
  api(js_unwrap(env, args[0], &data));
  return static_cast<Handle *>(data);
}

static js_value_t *step(js_env_t *env, js_callback_info_t *info) {
  try {
    auto handle = get(env, info);
    if (!handle->search)
      throw std::runtime_error("Search has been closed");
    auto value = handle->search->step();
    js_value_t *result;
    if (value.empty())
      api(js_get_null(env, &result));
    else
      api(js_create_string_utf8(env, reinterpret_cast<const utf8_t *>(value.data()),
                                value.size(), &result));
    return result;
  } catch (const std::exception &e) {
    js_throw_error(env, "ERR_VANITY_GPU", e.what());
    return nullptr;
  }
}

static js_value_t *close(js_env_t *env, js_callback_info_t *info) {
  try {
    get(env, info)->search.reset();
  } catch (const std::exception &e) {
    js_throw_error(env, "ERR_VANITY_GPU", e.what());
  }
  return nullptr;
}

static js_value_t *pear_vanity_gpu_exports(js_env_t *env, js_value_t *exports) {
  const char *names[] = {"create", "step", "close"};
  js_function_cb callbacks[] = {create, step, close};
  for (int i = 0; i < 3; i++) {
    js_value_t *value;
    api(js_create_function(env, names[i], -1, callbacks[i], nullptr, &value));
    api(js_set_named_property(env, exports, names[i], value));
  }
  return exports;
}
BARE_MODULE(pear_vanity_gpu, pear_vanity_gpu_exports)
