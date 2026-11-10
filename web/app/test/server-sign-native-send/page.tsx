// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { TestSendForm } from "./form";

export const metadata: Metadata = {
  title: "DO NOT MERGE — server sign native send",
  robots: { index: false, follow: false },
};

export default function TestSendPage() {
  return <TestSendForm />;
}
