// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AGPL-3.0 §13: users interacting with this program over a network must be offered its
 * Corresponding Source. The link target is configurable via NEXT_PUBLIC_SOURCE_URL.
 */
export const SOURCE_URL = process.env.NEXT_PUBLIC_SOURCE_URL || "https://github.com/skyzee2706/skybot-mint";

export function SiteFooter() {
  const external = /^https?:\/\//.test(SOURCE_URL);
  return (
    <footer className="site-footer">
      <span>© 2026 SkyBOT Mint</span>
      <span aria-hidden>·</span>
      <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">
        AGPL-3.0
      </a>
      <span aria-hidden>·</span>
      <a href={SOURCE_URL} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        Source
      </a>
    </footer>
  );
}
