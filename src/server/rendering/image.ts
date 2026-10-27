import sharp from "sharp";

export const TARGET_IMAGE_BYTES = 64000;

/** The same WebP resize policy for partial, viewport, and scroll images. */
export async function prepareImage(image: Buffer): Promise<Buffer> {
  let width = (await sharp(image).metadata()).width ?? 1000;
  while (image.length > TARGET_IMAGE_BYTES && width > 1) {
    width = Math.max(1, Math.trunc(width / 2));
    image = await sharp(image).resize(width).webp().toBuffer();
  }
  return image;
}
