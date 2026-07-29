/// <reference types="vite/client" />

declare global {
  interface Window {
    api: import('./ipc').NianyuAPI;
  }
}

export {};
