# macOS Distribution Plan for Codex GUI

## Summary

Ship macOS in two lanes, not one:

- Primary release lane: direct download of a `.dmg` from GitHub Releases or your website.
- CLI install lane: `brew install --cask codex-gui`, backed by the same signed release artifact.
- Defer a custom `curl | sh` installer and defer Mac App Store distribution.

This matches the current app shape. The GUI is a thin Electron shell that launches the local `codex` binary and works on user-selected workspaces, so direct distribution is a better fit than the Mac App Store.

## Recommended Distribution Design

- Use Electron Forge for packaging, code signing, and notarization on macOS.
- Produce two macOS artifacts per release: `arm64` and `x64`. Do not start with a universal binary.
- Publish a `.dmg` for normal users and a `.zip` for automation/Homebrew.
- Host artifacts on GitHub Releases first; add a website download page that points to those release assets.
- Add a Homebrew tap with a cask that installs the app into `/Applications`.
- Once signing/notarization is ready, document the CLI install as the preferred command-line path:

```bash
brew install --cask <tap>/codex-gui
```

## Important Interface and Product Changes

- Packaging/tooling:
  - Add Electron Forge config with macOS makers and `osxSign` / `osxNotarize`.
  - Add CI release jobs that build macOS artifacts, notarize when credentials are present, and upload release assets.
- First-run UX:
  - Replace the current raw startup failure with an explicit "Codex CLI not found" state.
  - Add a UI path to either detect `codex` on `PATH`, accept a manual binary path, or explain how to install/authenticate Codex first.
  - Keep `CODEX_BIN` as an advanced override, but do not make it the primary user-facing setup path.
- Release interface:
  - Direct download: mounted DMG -> drag app to Applications.
  - CLI install: Homebrew cask moves `Codex GUI.app` into `/Applications`.
  - Optional later addition, only if you want tighter coupling to the CLI: `codex install gui`, implemented as a thin wrapper around the same notarized release asset. Do not make this v1.

## Distribution Options Reviewed

- Direct DMG download:
  - Best standalone UX.
  - Best choice for the primary distribution path.
- Homebrew cask:
  - Best CLI-native install story on macOS.
  - Should be the official command-based install path once release artifacts are stable.
- PKG installer:
  - Not needed for a simple drag-install app.
  - Adds more ceremony than value here.
- Custom shell installer:
  - Not recommended as the primary path.
  - Worse trust story than Homebrew and does not remove Gatekeeper/notarization requirements.
- Mac App Store:
  - Not recommended.
  - Likely a poor fit for an app that launches an external CLI and operates on arbitrary local workspaces.

## Test Plan

- Fresh macOS machine, `codex` already installed:
  - DMG install launches cleanly and connects without setup friction.
  - Homebrew cask install places the app in `/Applications` and launches cleanly.
- Fresh macOS machine, `codex` missing:
  - App shows guided setup instead of a low-level spawn error.
- Unsigned interim build:
  - Verify tester docs cover Gatekeeper override flow.
- Signed/notarized build:
  - Verify first launch does not require right-click override.
  - Verify notarization is stapled to the shipped artifact.
- Architecture coverage:
  - Verify both `arm64` and `x64` builds start and can spawn the local `codex` binary.
- Upgrade behavior:
  - Installing a newer DMG or running `brew upgrade --cask` preserves app launchability and existing thread data expectations.

## Assumptions and Defaults

- Default path is standalone download first.
- Apple Developer signing/notarization is not available immediately, so support an interim tester flow first.
- When external distribution begins, signing + notarization becomes mandatory before broad rollout.
- Use GitHub Releases as the artifact source of truth initially.
- Use separate `arm64` and `x64` artifacts instead of a universal app for v1.

## Current App Context

- The Electron app currently spawns `codex app-server --listen stdio://` from the local machine.
- The app expects `codex` to be present on `PATH`, unless `CODEX_BIN` is explicitly set.
- The app allows the user to select a local workspace directory and then creates or resumes Codex threads against that workspace.

These constraints make direct distribution and Homebrew more appropriate than Mac App Store distribution.

## Sources

- Apple on Gatekeeper and notarized software outside the App Store: https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web
- Apple notarization overview: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- Electron Forge macOS signing/notarization: https://www.electronforge.io/guides/code-signing/code-signing-macos
- Homebrew Cask behavior and `app` artifact installation into `/Applications`: https://docs.brew.sh/Cask-Cookbook
- GitHub Releases as binary distribution assets: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
