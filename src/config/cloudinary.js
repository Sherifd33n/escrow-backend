import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_UPLOADS_ROOT = path.resolve(path.join(__dirname, "../../../uploads"));

export const isCloudinaryConfigured = () => {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
};

// Configure Cloudinary if credentials are provided
if (isCloudinaryConfigured()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

/**
 * Upload a file buffer directly to Cloudinary.
 * @param {Buffer} fileBuffer - The file data buffer
 * @param {object} options - Cloudinary upload options
 * @returns {Promise<{url: string, publicId: string, format: string, bytes: number}>}
 */
export async function uploadToCloudinary(fileBuffer, options = {}) {
  const { folder = "lumbrr", publicId, resourceType = "auto" } = options;

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        resource_type: resourceType,
        secure: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          format: result.format,
          bytes: result.bytes,
        });
      }
    );
    uploadStream.end(fileBuffer);
  });
}

/**
 * Helper to upload a multer memory file either to Cloudinary (if configured) or fallback to local disk.
 * @param {Express.Multer.File} file - Multer file with .buffer
 * @param {string} subfolder - e.g. "kyc" or "evidence"
 * @returns {Promise<string>} - The accessible file URL (https://... or /uploads/...)
 */
export async function uploadFile(file, subfolder = "kyc") {
  if (!file || !file.buffer) return null;

  if (isCloudinaryConfigured()) {
    const result = await uploadToCloudinary(file.buffer, {
      folder: `lumbrr/${subfolder}`,
      resourceType: "auto",
    });
    return result.url;
  }

  // Fallback to local disk storage if Cloudinary is not configured (e.g. offline local dev)
  const targetDir = path.join(LOCAL_UPLOADS_ROOT, subfolder);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const ext = path.extname(file.originalname || "").toLowerCase();
  const uniqueName = `${file.fieldname || "file"}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(targetDir, uniqueName);

  await fs.promises.writeFile(filePath, file.buffer);
  return `/uploads/${subfolder}/${uniqueName}`;
}

/**
 * Delete a file from Cloudinary by its public_id.
 * @param {string} publicId
 * @param {string} [resourceType="image"]
 */
export async function deleteFromCloudinary(publicId, resourceType = "image") {
  if (!isCloudinaryConfigured()) return null;
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}

export default cloudinary;
