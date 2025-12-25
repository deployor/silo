export class S3Error extends Error {
	constructor(
		public code: string,
		public message: string,
		public resource: string = "/",
		public requestId: string = "0000000000000000",
		public status: number = 403,
	) {
		super(message);
	}

	toResponse(): Response {
		return new Response(
			`<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>${this.code}</Code>
    <Message>${this.message}</Message>
    <Resource>${this.resource}</Resource>
    <RequestId>${this.requestId}</RequestId>
</Error>`,
			{
				status: this.status,
				headers: { "Content-Type": "application/xml" },
			},
		);
	}
}

export const S3Errors = {
	AccessDenied: (message = "Access Denied", resource = "/") =>
		new S3Error("AccessDenied", message, resource, undefined, 403),
	QuotaExceeded: (message = "You have exceeded your storage quota.", resource = "/") =>
		new S3Error("QuotaExceeded", message, resource, undefined, 403),
	NotImplemented: (
		message = "A header you provided implies functionality that is not implemented",
	) => new S3Error("NotImplemented", message, "/", undefined, 501),
	InternalError: (message = "Internal Server Error") =>
		new S3Error("InternalError", message, "/", undefined, 500),
	NoSuchCORSConfiguration: () =>
		new S3Error(
			"NoSuchCORSConfiguration",
			"The CORS configuration does not exist",
			"/",
			undefined,
			404,
		),
	MalformedXML: () =>
		new S3Error(
			"MalformedXML",
			"The XML you provided was not well-formed or did not validate against our published schema",
			"/",
			undefined,
			400,
		),
	InvalidRequest: (message = "Invalid Request") =>
		new S3Error("InvalidRequest", message, "/", undefined, 400),
	InvalidAccessKeyId: () =>
		new S3Error(
			"InvalidAccessKeyId",
			"The AWS Access Key Id you provided does not exist in our records.",
			"/",
			undefined,
			403,
		),
	SignatureDoesNotMatch: () =>
		new S3Error(
			"SignatureDoesNotMatch",
			"The request signature we calculated does not match the signature you provided.",
			"/",
			undefined,
			403,
		),
	MethodNotAllowed: () =>
		new S3Error("MethodNotAllowed", "Method Not Allowed", "/", undefined, 405),
};
