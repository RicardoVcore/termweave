/// <reference types="vite/client" />

import type { NativeApi, DesktopBridge } from "@termweave/contracts";

interface ImportMetaEnv {
  readonly APP_VERSION: string;
  readonly VITE_HOSTED_APP_CHANNEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    nativeApi?: NativeApi;
    desktopBridge?: DesktopBridge;
  }
}
