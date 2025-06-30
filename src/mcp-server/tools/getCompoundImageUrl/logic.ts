/**
 * @fileoverview Defines the core logic, schemas, and types for the `pubchem_get_compound_image` tool.
 * This tool fetches the raw image data for a given compound.
 * @module src/mcp-server/tools/getCompoundImageUrl/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod schema for input validation
export const PubchemGetCompoundImageInputSchema = z.object({
  cid: z
    .number()
    .int()
    .positive()
    .describe(
      "The PubChem Compound ID (CID) for which to fetch the image. Must be a positive integer.",
    ),
  size: z
    .enum(["small", "large"])
    .optional()
    .default("large")
    .describe(
      "Specifies the desired image size: 'small' (100x100) or 'large' (300x300). Defaults to 'large'.",
    ),
});

// 2. Define and export the TypeScript type for the input
export type PubchemGetCompoundImageInput = z.infer<
  typeof PubchemGetCompoundImageInputSchema
>;

// 3. Define and export the Zod schema for the tool's output
export const PubchemGetCompoundImageOutputSchema = z.object({
  cid: z
    .number()
    .int()
    .describe("The CID of the compound depicted in the image."),
  blob: z.instanceof(Buffer).describe("The raw image data as a Buffer object."),
  mimeType: z
    .string()
    .describe("The MIME type of the image (e.g., 'image/png')."),
});

// 4. Define and export the TypeScript type for the output
export type PubchemGetCompoundImageOutput = z.infer<
  typeof PubchemGetCompoundImageOutputSchema
>;

const PUBCHEM_IMAGE_BASE_URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";

/**
 * Core logic for the `pubchem_get_compound_image` tool. It constructs the image URL,
 * fetches the image data, and returns it as a blob.
 *
 * @param {PubchemGetCompoundImageInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and tracing.
 * @returns {Promise<PubchemGetCompoundImageOutput>} A promise that resolves with the image blob and metadata.
 * @throws {McpError} Throws a structured error if the image fetch fails or the CID is invalid.
 */
export async function pubchemGetCompoundImageLogic(
  params: PubchemGetCompoundImageInput,
  context: RequestContext,
): Promise<PubchemGetCompoundImageOutput> {
  logger.debug("Processing pubchem_get_compound_image logic...", {
    ...context,
    params,
  });

  const { cid, size } = params;

  const imageUrl = `${PUBCHEM_IMAGE_BASE_URL}/compound/cid/${cid}/PNG?record_type=2d&image_size=${size}`;

  try {
    const arrayBuffer = await pubChemApiClient.getBlob(imageUrl, context);

    const result: PubchemGetCompoundImageOutput = {
      cid,
      blob: Buffer.from(arrayBuffer),
      mimeType: "image/png",
    };

    logger.info(`Successfully fetched image for CID ${cid}.`, context);
    return result;
  } catch (error) {
    logger.error(`Failed to fetch image for CID ${cid} from ${imageUrl}`, {
      ...context,
      error,
    });
    throw new McpError(
      BaseErrorCode.EXTERNAL_SERVICE_ERROR,
      `Failed to fetch image for CID ${cid}. The compound may not exist or there was a network issue.`,
      { ...context, cid, imageUrl },
    );
  }
}
