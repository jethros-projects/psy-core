import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { normalizeConfig, formatActorRequiredError } from "./config.js";
import { IngestClient } from "./ingest-client.js";
import { PsyOpenClawObserver } from "./observer.js";

export default definePluginEntry({
  id: "psy-core",
  name: "psy-core",
  description: "Tamper-evident audit adapter for OpenClaw memory and skill access.",
  register(api) {
    const config = normalizeConfig(api.pluginConfig);
    if (!config.enabled) {
      api.logger.info("psy-core-openclaw is disabled (config.enabled=false)");
      return;
    }
    if (!config.actorId && !config.allowAnonymous) {
      api.logger.error(formatActorRequiredError());
      return;
    }

    const ingest = config.dryRun ? null : new IngestClient({ config, logger: api.logger });
    const observer = new PsyOpenClawObserver({
      config,
      logger: api.logger,
      ingest,
      getAppConfig: () => api.runtime?.config?.current?.() ?? api.config ?? {},
    });

    api.on("before_tool_call", (event, ctx) => observer.beforeToolCall(event, ctx), {
      priority: 20,
      timeoutMs: config.hookTimeoutMs,
    });
    api.on("after_tool_call", (event, ctx) => observer.afterToolCall(event, ctx), {
      priority: 20,
      timeoutMs: config.hookTimeoutMs,
    });
    api.on("gateway_stop", () => observer.close(), {
      priority: -20,
      timeoutMs: 1_000,
    });

    api.logger.info("psy-core-openclaw registered memory/skill audit adapter hooks");
  },
});
