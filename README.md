# dsh-ninfer-fixes

Minimal DSH plugin. Its first fix translates NInfer's exact vision raw-patch overflow into DSH's existing durable image-offload recovery. Ready-to-run JavaScript; no build, prepare, or postinstall script.

## Compatibility and prerequisites

Validated with **DSH 0.2.1-rc.2**, Cordis 4.0.5 and Node 24. Other releases and other adapters are unverified. The installed pi-ai dependency is @earendil-works/pi-ai 1.1.0.

Installation has no DSH version pin or Node engine restriction. The only required runtime peer is `@deepseek-ai/dsh-llm: "*"`, which supplies the signal constant and LlmError. The official offload package is an optional wildcard peer so a profile-provided copy can be used without forcing installation; enabling its listener is still required for recovery. Cordis and the pi-ai adapter are test-only development dependencies. Exact development pins reproduce the validated environment, not installation restrictions. Wildcard peer ranges do not guarantee compatibility with future API changes.

Use existing NInfer routes through `@deepseek-ai/dsh-llm-pi-ai` with `openai-completions`. Model IDs are unrestricted. An optional provider allowlist can restrict matching to existing NInfer routes; the plugin does not inspect endpoints or alter model settings.

The official `@deepseek-ai/dsh-compaction-image-offload` plugin must be enabled in the same agent/session scope. It is an optional peer dependency because the host profile may already provide it; installing a package alone does not activate its listener. Do not mount a second copy if the base bundle already provides it.

Inspection of this machine found the desktop profile bundles `@deepseek-ai/dsh-base`; its installed patch enables `image-offload`, and the desktop patch does not disable it. This verifies the saved composition, not a live process's loaded state. The plugin also fails explicitly if downstream recovery makes no durable progress.

## Install from DSH's GUI

Open **Plugins → Install a third-party plugin** and paste:

```text
https://github.com/nyakaspeter/dsh-ninfer-fixes
```

Install and enable the bundle. Its included `cordis.patch.yml` mounts the plugin with a 32-retry bound. No build or lifecycle scripts run, and no model settings are added.

The official image-offload plugin must already be active in the same scope (as in the inspected standard base bundle). This bundle does not mount a duplicate official plugin. If recovery finds no official listener making progress, it stops with a clear error.

By default the plugin recognizes the exact NInfer signature on any provider route. To restrict it to selected existing provider IDs, add an override to your profile's `cordis.patch.yml`:

```yaml
- id: ninfer-fixes
  config:
    providers: [your-ninfer-provider]
    maxRetries: 32
```

`providers` is optional. When supplied, it must be a nonempty list of provider IDs. `maxRetries` accepts integers 1–1024. No provider, model, sampling, or preset configuration is changed.

For command-line installation use `dsh plugin add https://github.com/nyakaspeter/dsh-ninfer-fixes`, or install the release archive into a profile with pnpm and add the package to that profile's `dsh.profile.bundles`. The GUI does this bundle registration for you.

Development and publication did not install this plugin into the author's active profile.

## Recovery contract

The prepended `agent/request-error` waterfall listener accepts only `INVALID_REQUEST` carrying HTTP 400 plus a complete JSON object (direct or under `error`) with all four exact fields:

```json
{"code":"media_budget_exceeded","message":"vision raw patches exceed processor budget","param":"messages","type":"invalid_request_error"}
```

The pi-ai adapter preserves these facts in its message string. Incomplete, truncated, reformatted plain-text errors and unrelated context/media failures are deliberately rejected. When configured, the provider allowlist also excludes other routes. Without an allowlist, matching relies on the exact NInfer error signature.

The hook replaces `payload.failure` with the exported `LlmError(..., IMAGE_OFFLOAD_REQUIRED_CODE, {offloadImages: 1}).failure`, then calls `next()`. It does not throw that signal or invent an action object. Cordis passes the same payload to downstream listeners. The official listener selects the oldest retained user/tool image occurrence, appends `image/offload`, and returns `{kind: 'retry'}`. DSH's agent loop then rebuilds the request and retries, applying the official persisted omission projection.

This plugin only reads projected session messages to guard recovery. It neither edits requests nor writes session events. It verifies that exactly the oldest retained occurrence disappeared before forwarding the official retry action. It stops before the last eligible image is removed, on missing progress, or after the configured number of recovery attempts per agent/turn/step/provider. Counters use a WeakMap and do not persist across process restarts. Errors use `NINFER_IMAGE_RECOVERY_STOPPED` and explain the stopping condition. Newest means the last eligible input-image occurrence in the official surface order.

The scope is agent requests. Compaction summary recovery is intentionally outside this fix. Official preflight offload signals and other plugins' independent recovery policies retain their own behavior.

## Tests

For development, install the package’s development dependencies with `pnpm install --ignore-scripts`, then run:

```sh
node --test test/plugin.test.js
```

The HTTP test additionally needs the installed adapter's `@earendil-works/pi-ai` 1.1.0 accessible to Node (a hoisted install or an isolated test workspace). No real provider credentials or endpoints are used.

Validation on the installed DSH 0.2.1-rc.2: **11 tests passed**. The integration test runs the installed PiAiAdapter stream translation and its real pi-ai/OpenAI HTTP client against a loopback mock server: two exact 400 failures, two official durable omissions through real Cordis, then a successful streamed response on request three. A minimal model registry and in-memory session store supply the harness services. It exercises the official offload projection rather than mocking selection. The HTTP requests use text content to isolate error transport; this is not an end-to-end screenshot/attachment-storage or complete agent-loop test.

The installed DSH bundle parser and compatibility evaluator also accept the package metadata and insertion patch.

Focused tests cover exact recognition, unrelated error rejection, default activation without provider configuration, optional provider scoping, oldest-first handoff, newest preservation, already-offloaded images, zero/one remaining image, retry limits, missing official executor, false retry without progress, and configuration validation.

## Inspected contract evidence

All paths below are relative to the installed desktop archive's `dsh/node_modules` (read-only extracted for validation):

- `@deepseek-ai/dsh-agent-loop/lib/index.js:1136`: dispatches `agent/request-error`; only `action.kind === 'retry'` continues its request loop.
- `@deepseek-ai/cordis/lib/index.js:317`: waterfall shares its argument payload; `next()` advances listeners. Listener registration supports `prepend`.
- `@deepseek-ai/dsh-compaction-image-offload/lib/index.js:141`: official agent listener consumes `failure.code` and `offloadImages`, records the oldest omissions and returns retry. Its selector can remove the final image, so this plugin guards before delegating.
- `@deepseek-ai/dsh-llm/lib/index.js:236,1620`: exported signal constant and `LlmError` failure snapshot.
- `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1450–1522`: error text classification and terminal failure mapping; HTTP 400 becomes INVALID_REQUEST without a structured status/body field.
- `@earendil-works/pi-ai/dist/api/openai-completions.js:490`: preserves HTTP body through error normalization/formatting.
- `@deepseek-ai/dsh-base/cordis.patch.yml:434`: enables the official offload plugin.

No installed DSH core, provider, node_modules, active profile, or existing configuration files were modified. The bundle patch in this repository is delivered for installation.
