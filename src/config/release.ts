// Copyright 2026 Tauric Research
// SPDX-License-Identifier: Apache-2.0
// Changed in this fork of TradingAgents 1.0.0.
/**
 * Where releases come from and how they are installed: the public repository, its latest release,
 * the installer, and the npm packages. The npm launcher (scripts/npm/launcher.js) is shipped as written
 * and repeats its names; a test keeps them equal to these.
 */
import { APP_NAME } from "../contracts/index.js";

/** The public repository. */
export const REPOSITORY_URL = "https://github.com/youill0317/TradingAgents";

/** Where a newer release is looked up: the release the public repository marks latest. */
export const RELEASE_URL = "https://api.github.com/repos/youill0317/TradingAgents/releases/latest";

/**
 * How to install from scratch. This fork publishes no release, so there is no installer to fetch
 * (release.yml attaches one to each release): it is built from source, as docs/install.md says.
 */
export const INSTALL_COMMAND =
  "git clone --branch claude/dazzling-fermat-ik4q5y https://github.com/youill0317/TradingAgents.git, then npm ci and npm run compile in it (docs/install.md)";

/** The npm package people install, and the start of each platform's package name (`<prefix><os>-<cpu>`). */
export const NPM_PACKAGE = `@tauric/${APP_NAME}`;
export const NPM_PLATFORM_PREFIX = `${NPM_PACKAGE}-`;
/** The command that installs or updates the npm package. */
export const NPM_UPDATE_COMMAND = `npm i -g ${NPM_PACKAGE}`;
