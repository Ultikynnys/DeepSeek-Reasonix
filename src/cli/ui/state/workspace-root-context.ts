import { createContext } from "react";

/** Absolute project root directory. Consumed by card renderers that need to
 *  resolve relative tool-arg paths into clickable `file://` OSC8 links. */
export const WorkspaceRootContext = createContext<string | null>(null);
