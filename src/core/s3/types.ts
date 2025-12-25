export interface CORSRule {
	ID?: string;
	AllowedHeaders?: string[];
	AllowedMethods: string[];
	AllowedOrigins: string[];
	ExposeHeaders?: string[];
	MaxAgeSeconds?: number;
}

export interface CORSConfiguration {
	CORSRules: CORSRule[];
}
