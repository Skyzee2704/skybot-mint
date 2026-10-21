// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";

export const metadata = { title: "Source Code · SkyBOT Mint" };

export default function SourcePage() {
  return (
    <main className="source-page">
      <h1>Source Code</h1>
      <p>
        SkyBOT Mint is free software licensed under the{" "}
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">
          GNU Affero General Public License v3.0 only
        </a>{" "}
        (AGPL-3.0-only). You are entitled to the complete corresponding source code of the version running on this site.
      </p>
      <p className="muted">
        The operator of this instance has not yet configured a public repository link (<code>NEXT_PUBLIC_SOURCE_URL</code>). Please contact
        the operator to obtain the source code.
      </p>
      <p>
        <Link href="/">Back to SkyBOT Mint</Link>
      </p>
    </main>
  );
}
