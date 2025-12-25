import { XMLParser } from "fast-xml-parser";

const xml = `
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<CORSRule>
<AllowedMethod>GET</AllowedMethod>
<AllowedOrigin>*</AllowedOrigin>
<AllowedHeader>*</AllowedHeader>
</CORSRule>
</CORSConfiguration>
`;

const parser = new XMLParser({
	ignoreAttributes: false,
	isArray: (name: string) => {
		return (
			[
				"CORSRule",
				"AllowedOrigin",
				"AllowedMethod",
				"AllowedHeader",
				"ExposeHeader",
			].indexOf(name) !== -1
		);
	},
});

const parsed = parser.parse(xml);
console.log(JSON.stringify(parsed, null, 2));

const rules = parsed.CORSConfiguration.CORSRule.map((r: any) => {
	// Ensure arrays for single values
	const allowedOrigins = r.AllowedOrigin
		? Array.isArray(r.AllowedOrigin)
			? r.AllowedOrigin
			: [r.AllowedOrigin]
		: [];

	const allowedMethods = r.AllowedMethod
		? Array.isArray(r.AllowedMethod)
			? r.AllowedMethod
			: [r.AllowedMethod]
		: [];

	return {
		ID: r.ID,
		AllowedOrigins: allowedOrigins,
		AllowedMethods: allowedMethods,
	};
});

console.log("Rules:", JSON.stringify(rules, null, 2));
