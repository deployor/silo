import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";

export class HetznerS3Client {
  private client: S3Client;
  private bucket: string;

  constructor() {
    const { accessKeyId, secretAccessKey, endpoint, bucket, region } =
      config.s3;

    if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
      throw new Error("Missing S3 configuration environment variables");
    }

    this.bucket = bucket;

    // Ensure endpoint has protocol
    const endpointUrl = endpoint.startsWith("http")
      ? endpoint
      : `https://${endpoint}`;

    this.client = new S3Client({
      region: region || "auto",
      endpoint: endpointUrl,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: true, // Hetzner/Impossible Cloud often works better with path style internally
    });
  }

  async getObject(key: string) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return this.client.send(command);
  }

  async putObject(
    key: string,
    body: any,
    contentType?: string,
    contentLength?: number,
  ) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: contentLength,
    });
    return this.client.send(command);
  }

  async deleteObject(key: string) {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return this.client.send(command);
  }

  async headObject(key: string) {
    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return this.client.send(command);
  }

  async listObjectsV2(
    prefix: string,
    delimiter?: string,
    continuationToken?: string,
    maxKeys?: number,
    startAfter?: string,
  ) {
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      Delimiter: delimiter,
      ContinuationToken: continuationToken,
      MaxKeys: maxKeys,
      StartAfter: startAfter,
    });
    return this.client.send(command);
  }

  async copyObject(sourceKey: string, destinationKey: string) {
    const command = new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: `${this.bucket}/${sourceKey}`,
      Key: destinationKey,
    });
    return this.client.send(command);
  }

  async createMultipartUpload(key: string, contentType?: string) {
    const command = new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return this.client.send(command);
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: any,
  ) {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
    });
    return this.client.send(command);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { ETag?: string; PartNumber: number }[],
  ) {
    const command = new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts,
      },
    });
    return this.client.send(command);
  }

  async abortMultipartUpload(key: string, uploadId: string) {
    const command = new AbortMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
    });
    return this.client.send(command);
  }

  async deleteObjects(keys: string[]) {
    const command = new DeleteObjectsCommand({
      Bucket: this.bucket,
      Delete: {
        Objects: keys.map((Key) => ({ Key })),
      },
    });
    return this.client.send(command);
  }

  // Helper to get a signed URL for direct upload/download if needed
  async getSignedUrl(key: string, operation: "getObject" | "putObject") {
    const command =
      operation === "getObject"
        ? new GetObjectCommand({ Bucket: this.bucket, Key: key })
        : new PutObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }

  getBucketName() {
    return this.bucket;
  }
}

export const s3Client = new HetznerS3Client();
