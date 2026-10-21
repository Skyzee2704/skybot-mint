// SPDX-License-Identifier: AGPL-3.0-only
import { AppShell } from "@/components/AppShell";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
