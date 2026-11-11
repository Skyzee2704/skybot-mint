// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { server } from "@/lib/server";
import { TestSendForm } from "./form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "DO NOT MERGE — server sign native send",
  robots: { index: false, follow: false },
};

export default async function TestSendPage() {
  const s = await server();
  return <TestSendForm wallets={s.testSendWalletAllowlist()} chains={s.testSendChainOptions()} />;
}
