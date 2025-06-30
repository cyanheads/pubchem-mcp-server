/**
 * @fileoverview A singleton service to interact with the PubChem PUG REST API.
 * This client handles URL construction, rate limiting, request execution,
 * and error handling for all PubChem API interactions.
 * @module src/services/pubchem/pubchemApiClient
 */

import { RateLimiter } from "limiter";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  fetchWithTimeout,
  logger,
  type RequestContext,
} from "../../utils/index.js";

const PUBCHEM_API_BASE_URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const PUBCHEM_API_TIMEOUT_MS = 30000; // 30 seconds

/**
 * A singleton class to manage all interactions with the PubChem PUG REST API.
 */
class PubChemApiClient {
  private static instance: PubChemApiClient;
  private readonly limiter: RateLimiter;

  /**
   * Private constructor to enforce the singleton pattern.
   * Initializes a rate limiter compliant with PubChem's policy (5 requests/sec).
   */
  private constructor() {
    this.limiter = new RateLimiter({
      tokensPerInterval: 5,
      interval: "second",
    });
    logger.info(
      "PubChemApiClient initialized with a rate limit of 5 requests/second.",
    );
  }

  /**
   * Retrieves the singleton instance of the PubChemApiClient.
   * @returns The singleton instance.
   */
  public static getInstance(): PubChemApiClient {
    if (!PubChemApiClient.instance) {
      PubChemApiClient.instance = new PubChemApiClient();
    }
    return PubChemApiClient.instance;
  }

  /**
   * Executes a request to the PubChem API for a JSON response, respecting the rate limit.
   * @param path - The API endpoint path (e.g., '/compound/cid/2244/property/MolecularFormula/JSON').
   * @param context - The request context for tracing and logging.
   * @returns A promise that resolves with the JSON response from the API.
   * @throws {McpError} If the request fails, times out, or the API returns an error.
   */
  public async get(path: string, context: RequestContext): Promise<any> {
    const response = await this.executeRequest(path, context);
    // Handle cases where the response is OK but there's no content
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }

  /**
   * Executes a request to the PubChem API for a binary blob response, respecting the rate limit.
   * @param path - The API endpoint path (e.g., '/compound/cid/2244/PNG').
   * @param context - The request context for tracing and logging.
   * @returns A promise that resolves with an ArrayBuffer of the response body.
   * @throws {McpError} If the request fails or times out.
   */
  public async getBlob(
    path: string,
    context: RequestContext,
  ): Promise<ArrayBuffer> {
    const response = await this.executeRequest(path, context);
    return response.arrayBuffer();
  }

  /**
   * Private helper to execute a generic fetch request, handling rate limiting and basic error checking.
   * @param path - The API endpoint path.
   * @param context - The request context.
   * @returns A promise that resolves with the raw Response object.
   */
  private async executeRequest(
    path: string,
    context: RequestContext,
  ): Promise<Response> {
    await this.limiter.removeTokens(1);
    const url = path.startsWith("http")
      ? path
      : `${PUBCHEM_API_BASE_URL}${path}`;
    logger.debug(`Executing PubChem API GET request`, { ...context, url });

    const response = await fetchWithTimeout(
      url,
      PUBCHEM_API_TIMEOUT_MS,
      context,
    );

    if (!response.ok) {
      const errorText = await response.text();
      const pubChemStatus =
        response.headers.get("pubchem-pug-status-message") ||
        "No status message";
      logger.error("PubChem API request failed", {
        ...context,
        url,
        status: response.status,
        statusText: response.statusText,
        pubChemStatus,
        responseBody: errorText,
      });

      // Map HTTP status codes to McpError codes
      let errorCode: BaseErrorCode;
      switch (response.status) {
        case 400:
          errorCode = BaseErrorCode.INVALID_INPUT;
          break;
        case 404:
          errorCode = BaseErrorCode.NOT_FOUND;
          break;
        case 405:
          errorCode = BaseErrorCode.METHOD_NOT_ALLOWED;
          break;
        case 503:
          errorCode = BaseErrorCode.SERVICE_UNAVAILABLE;
          break;
        case 504:
          errorCode = BaseErrorCode.GATEWAY_TIMEOUT;
          break;
        default:
          errorCode = BaseErrorCode.EXTERNAL_SERVICE_ERROR;
      }

      throw new McpError(errorCode, `PubChem API Error: ${pubChemStatus}`, {
        httpStatusCode: response.status,
        details: errorText,
      });
    }
    return response;
  }
}

/**
 * Singleton instance of the PubChem API client.
 */
export const pubChemApiClient = PubChemApiClient.getInstance();
