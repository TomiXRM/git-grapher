// Strip repository- and index-selecting environment variables from every git command, helper and shell script.
// Reads and writes must use the same repository and index even if herdr inherited GIT_DIR or GIT_INDEX_FILE.
import { exec } from "herdr";
import { UNSET } from "./lib/core.js";

// GIT_LITERAL_PATHSPECS=1 treats names such as "*.txt" literally.
// Remove other global pathspec modes because git refuses them alongside literal mode.
export const gitRun = (cmd, args, opt) => exec("env", [...UNSET.flatMap((v) => ["-u", v]), "GIT_LITERAL_PATHSPECS=1", cmd, ...args], opt);
