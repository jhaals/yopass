import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import * as fs from "fs";
import * as path from "path";

const config: Config = {
  title: "Yopass",
  tagline: "Share Secrets Securely",
  favicon: "logo/favicon.ico",
  headTags: [
    {
      tagName: "link",
      attributes: { rel: "icon", type: "image/svg+xml", href: "/logo/favicon.svg" },
    },
    {
      tagName: "link",
      attributes: { rel: "apple-touch-icon", sizes: "180x180", href: "/logo/apple-touch-icon.png" },
    },
  ],

  url: "https://yopass.se",
  baseUrl: "/",
  trailingSlash: false,

  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  customFields: {
    checkoutUrl:
      process.env.CHECKOUT_URL ?? "https://license.yopass.se/checkout",
  },

  presets: [
    [
      "classic",
      {
        docs: {
          path: path.resolve(__dirname, "../docs"),
          routeBasePath: "docs",
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
        sitemap: {
          changefreq: "weekly",
          priority: 0.5,
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      "@docusaurus/plugin-client-redirects",
      {
        redirects: [
          {
            from: "/docs",
            to: "/docs/intro",
          },
        ],
      },
    ],
    async function tailwindPlugin() {
      return {
        name: "docusaurus-tailwindcss",
        configurePostCss(postcssOptions: { plugins: unknown[] }) {
          postcssOptions.plugins.push(require("@tailwindcss/postcss"));
          postcssOptions.plugins.push(require("autoprefixer"));
          return postcssOptions;
        },
      };
    },
  ],

  themeConfig: {
    colorMode: {
      defaultMode: "light",
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },

    navbar: {
      hideOnScroll: false,
      logo: {
        alt: "Yopass",
        src: "logo/yopass-full.svg",
        width: 138,
        height: 28,
        href: "/",
      },
      items: [
        {
          to: "/docs/intro",
          label: "Docs",
          position: "left",
        },
        {
          href: "https://github.com/jhaals/yopass",
          label: "GitHub",
          position: "right",
        },
        {
          href: "https://share.yopass.se",
          label: "Demo",
          position: "right",
        },
        {
          type: "html",
          position: "right",
          value: '<a href="/#pricing" class="navbar-cta">Get Started</a>',
        },
      ],
    },

    footer: {
      style: "light",
      copyright: `© ${new Date().getFullYear()} Yopass AB`,
      links: [
        {
          items: [
            { label: "GitHub", href: "https://github.com/jhaals/yopass" },
            { label: "Documentation", to: "/docs/intro" },
            { label: "Demo", href: "https://share.yopass.se" },
            { label: "Privacy Policy", to: "/privacy" },
            { label: "Terms of Service", to: "/tos" },
          ],
        },
      ],
    },

    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },

    metadata: [
      { name: "theme-color", content: "#fafbfc" },
      { name: "color-scheme", content: "light" },
    ],
  } satisfies Preset.ThemeConfig,
};

export default config;
