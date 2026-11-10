// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import Link from "next/link";
import { useLang } from "@/lib/i18n";

export default function SourcePage() {
  const { t } = useLang();
  return (
    <main className="source-page">
      <h1>{t("Source Code")}</h1>
      <p>
        {t("SkyBOT Mint is free software licensed under the")}{" "}
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">
          GNU Affero General Public License v3.0 only
        </a>{" "}
        {t("(AGPL-3.0-only). You are entitled to the complete corresponding source code of the version running on this site.")}
      </p>
      <p className="muted">
        {t("The operator of this instance has not yet configured a public repository link")} (<code>NEXT_PUBLIC_SOURCE_URL</code>)
        {t("). Please contact the operator to obtain the source code.")}
      </p>
      <p>
        <Link href="/">{t("Back to SkyBOT Mint")}</Link>
      </p>
    </main>
  );
}
