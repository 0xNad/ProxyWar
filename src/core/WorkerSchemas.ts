import { z } from "zod";
import {
  ExternalGameConfigSchema,
  ExternalGameConfigUpdateSchema,
} from "./Schemas";

export const CreateGameInputSchema = ExternalGameConfigSchema.or(
  z
    .object({})
    .strict()
    .transform((val) => undefined),
);

export const GameInputSchema = ExternalGameConfigUpdateSchema;
