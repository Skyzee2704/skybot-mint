// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Well-known ERC-20s read over RPC when Alchemy's "all tokens" scan misses them.
 * Addresses are the canonical deployments (checksummed at load). Chains without a published
 * list (Robinhood, Arc, Elysium) are omitted rather than guessed.
 */
import { getAddress } from "ethers";

export interface KnownToken {
  symbol: string;
  address: string;
}

const t = (symbol: string, address: string): KnownToken => ({ symbol, address: getAddress(address) });
const WETH9 = "0x4200000000000000000000000000000000000006";

export const KNOWN_TOKENS: Record<string, KnownToken[]> = {
  ethereum: [
    t("USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    t("USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7"),
    t("WETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    t("DAI", "0x6B175474E89094C44Da98b954EedeAC495271d0F"),
  ],
  base: [
    t("USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    t("USDT", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"),
    t("WETH", WETH9),
    t("DAI", "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"),
  ],
  polygon: [
    t("USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
    t("USDC.e", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),
    t("USDT", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"),
    t("WETH", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"),
    t("WPOL", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"),
    t("DAI", "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"),
  ],
  arbitrum: [
    t("USDC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
    t("USDC.e", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"),
    t("USDT", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"),
    t("WETH", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
    t("DAI", "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"),
  ],
  bnb: [
    t("USDC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
    t("USDT", "0x55d398326f99059fF775485246999027B3197955"),
    t("WBNB", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
    t("BUSD", "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56"),
    t("ETH", "0x2170Ed0880ac9A755fd29B2688956BD959F933F8"),
    t("DAI", "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3"),
  ],
  unichain: [
    t("USDC", "0x078D782b760474a361dDA0AF3839290b0EF57AD6"),
    t("USDT0", "0x9151434b16b9763660705744891fA906F660EcC5"),
    t("WETH", WETH9),
  ],
  ink: [
    t("WETH", WETH9),
    t("USDC", "0x2D270e6886d130D724215A266106e6832161EAEd"),
    t("USDC.e", "0xF1815bd50389c46847f0Bda824eC8da914045D14"),
    t("USDT0", "0x0200C29006150606B650577BBE7B6248F58470c1"),
  ],
};
