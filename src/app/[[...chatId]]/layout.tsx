import type { ReactNode } from "react";

import { ChatShell } from "./page";

export default function ChatLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ChatShell />
      {children}
    </>
  );
}
