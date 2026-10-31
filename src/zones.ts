import picomatch from "picomatch";
import type { Config } from "./config.js";
import type { Token } from "./spec.js";

/** Whether `token` may be used in `file` under the configured zones. */
export function allowedInZones(token: Token, file: string, config: Config): boolean {
  return config.zones.every((zone) => {
    const inZone = picomatch(zone.files)(file) && !(zone.ignore?.length && picomatch(zone.ignore)(file));
    if (!inZone) return true;
    if (zone.denyTokens?.length && picomatch(zone.denyTokens)(token.name)) return false;
    return !zone.allowTokens?.length || picomatch(zone.allowTokens)(token.name);
  });
}
