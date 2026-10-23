import type { Config } from "./config";
import type { State } from "./state";

export interface RouteContext {
  config: Config;
  state: State;
}
