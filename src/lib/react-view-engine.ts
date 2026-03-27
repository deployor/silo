import { config } from "../config";
import { isReactPageId } from "./react-pages";

type RenderOptions = {
	layout?: string | boolean;
};

type ViewData = Record<string, unknown> & {
	title?: string;
	bodyClass?: string;
};

function escapeForInlineJson(value: string): string {
	return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

export function isReactPage(templateName: string): boolean {
	return isReactPageId(templateName);
}

export function renderReactDocument(
	templateName: string,
	viewData: ViewData = {},
	options: RenderOptions = { layout: "main" },
): string {
	const title = viewData.title || "Silo";
	const assetVersion =
		config.git?.shortSha || config.git?.buildDate || String(Date.now());
	const cssHref = `/assets/react/app.css?v=${encodeURIComponent(assetVersion)}`;
	const jsSrc = `/assets/react/app.js?v=${encodeURIComponent(assetVersion)}`;
	const bootstrap = {
		page: templateName,
		title,
		layout: options.layout,
		props: viewData,
		config: {
			env: config.env,
			git: config.git,
			cloudflareForSaas: {
				targetHostname: config.cloudflareForSaas.targetHostname,
				configured: config.cloudflareForSaas.configured,
			},
		},
	};

	const bootstrapJson = escapeForInlineJson(JSON.stringify(bootstrap));

	return `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title} - Free S3 Storage for Hack Club</title>
    <meta name="description" content="Free S3-compatible object storage for Hack Club members. Ship your projects, earn more storage. Built on Cloudflare R2 for high performance." />
    <meta name="keywords" content="free s3 storage, hack club, object storage, s3 gateway, cloudflare r2, developer tools, free tier" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://silo.hackclub.com/" />
    <meta property="og:title" content="Silo - Free S3 Storage for Hack Club" />
    <meta property="og:description" content="Free S3-compatible object storage for Hack Club members. Ship your projects, earn more storage." />
    <meta property="og:image" content="https://assets.hackclub.com/icon-rounded.png" />
    <meta property="twitter:card" content="summary_large_image" />
    <meta property="twitter:url" content="https://silo.hackclub.com/" />
    <meta property="twitter:title" content="Silo - Free S3 Storage for Hack Club" />
    <meta property="twitter:description" content="Free S3-compatible object storage for Hack Club members. Ship your projects, earn more storage." />
    <meta property="twitter:image" content="https://assets.hackclub.com/icon-rounded.png" />
	    <link rel="stylesheet" href="${cssHref}" />
	  </head>
	  <body class="min-h-screen selection:bg-hc-red selection:text-white font-sans ${viewData.bodyClass || ""}">
	    <div id="root"></div>
	    <script>window.__SILO_APP__ = ${bootstrapJson};</script>
	    <script type="module" src="${jsSrc}"></script>
	  </body>
	</html>`;
}
