import type { Config } from "./config";
import type { State } from "./state";
import type { Terminals } from "./terminals";

export interface RouteContext {
  config: Config;
  state: State;
  terminals: Terminals;
}
