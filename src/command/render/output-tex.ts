/*
* output-tex.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { dirname, isAbsolute, join, normalize, relative } from "path/mod.ts";
import { ensureDirSync } from "fs/mod.ts";

import { writeFileToStdout } from "../../core/console.ts";
import { dirAndStem, expandPath } from "../../core/path.ts";
import { texSafeFilename } from "../../core/tex.ts";

import { kKeepTex, kOutputExt, kOutputFile } from "../../config/constants.ts";
import { Format } from "../../config/types.ts";

import { PandocOptions, RenderFlags, RenderOptions } from "./types.ts";
import { kStdOut, replacePandocOutputArg } from "./flags.ts";
import { OutputRecipe } from "./types.ts";
import { pdfEngine } from "../../config/pdf.ts";
import { execProcess } from "../../core/process.ts";

export type PdfGenerator = (
  input: string,
  format: Format,
  pandocOptions: PandocOptions,
) => Promise<string>;

export function texToPdfOutputRecipe(
  input: string,
  finalOutput: string,
  options: RenderOptions,
  format: Format,
  pdfIntermediateTo: string,
  pdfGenerator: PdfGenerator,
  pdfOutputDir?: string | null,
): OutputRecipe {
  // break apart input file
  const [inputDir, inputStem] = dirAndStem(input);

  // there are many characters that give tex trouble in filenames, create
  // a target stem that replaces them with the '-' character
  const texStem = texSafeFilename(inputStem);

  // cacluate output and args for pandoc (this is an intermediate file
  // which we will then compile to a pdf and rename to .tex)
  const output = texStem + ".tex";
  let args = options.pandocArgs || [];
  const pandoc = { ...format.pandoc };
  if (options.flags?.output) {
    args = replacePandocOutputArg(args, output);
  } else {
    pandoc[kOutputFile] = output;
  }

  // when pandoc is done, we need to run the pdf generator and then copy the
  // ouptut to the user's requested destination
  const complete = async (pandocOptions: PandocOptions) => {
    const input = join(inputDir, output);
    const pdfOutput = await pdfGenerator(input, format, pandocOptions);

    // keep tex if requested
    const compileTex = join(inputDir, output);
    if (!format.render[kKeepTex]) {
      Deno.removeSync(compileTex);
    }

    const normalizePath = (input: string, output: string) => {
      if (isAbsolute(output)) {
        return output;
      } else {
        return relative(
          Deno.realPathSync(dirname(input)),
          Deno.realPathSync(output),
        );
      }
    };

    // copy (or write for stdout) compiled pdf to final output location
    if (finalOutput) {
      if (finalOutput === kStdOut) {
        writeFileToStdout(pdfOutput);
        Deno.removeSync(pdfOutput);
      } else {
        const outputPdf = expandPath(finalOutput);

        if (normalize(pdfOutput) !== normalize(outputPdf)) {
          // ensure the target directory exists
          ensureDirSync(dirname(outputPdf));

          Deno.renameSync(pdfOutput, outputPdf);
        }
      }

      // Clean the output directory if it is empty
      if (pdfOutputDir) {
        try {
          // Remove the outputDir if it is empty
          Deno.removeSync(pdfOutputDir, { recursive: false });
        } catch {
          // This is ok, just means the directory wasn't empty
        }
      }

      // final output needs to either absolute or input dir relative
      // (however it may be working dir relative when it is passed in)
      return normalizePath(input, finalOutput);
    } else {
      return normalizePath(input, pdfOutput);
    }
  };

  // tweak writer if it's pdf
  const to = format.pandoc.to === "pdf" ? pdfIntermediateTo : format.pandoc.to;

  // return recipe
  return {
    output,
    keepYaml: false,
    args,
    format: {
      ...format,
      pandoc: {
        ...pandoc,
        to,
      },
    },
    complete,
  };
}

export function useContextPdfOutputRecipe(
  format: Format,
  flags?: RenderFlags,
) {
  const kContextPdfEngine = "context";
  if (format.pandoc.to === "pdf" && format.render[kOutputExt] === "pdf") {
    const engine = pdfEngine(format.pandoc, format.render, flags);
    return engine.pdfEngine === kContextPdfEngine;
  } else {
    return false;
  }
}

// based on: https://github.com/rstudio/rmarkdown/blob/main/R/context_document.R

export function contextPdfOutputRecipe(
  input: string,
  finalOutput: string,
  options: RenderOptions,
  format: Format,
): OutputRecipe {
  const pdfGenerator = async (
    input: string,
    format: Format,
    pandocOptions: PandocOptions,
  ): Promise<string> => {
    // derive engine (parse opts, etc.)
    const engine = pdfEngine(format.pandoc, format.render, pandocOptions.flags);

    // build context command
    const cmd = ["context", input];
    if (engine.pdfEngineOpts) {
      cmd.push(...engine.pdfEngineOpts);
    }
    cmd.push(
      // ConTeXt produces some auxiliary files:
      // direct PDF generation by Pandoc never produces these auxiliary
      // files because Pandoc runs ConTeXt in a temporary directory.
      // Replicate Pandoc's behavior using "--purgeall" option
      "--purgeall",
      // Pandoc runs ConteXt with "--batchmode" option. Do the same.
      "--batchmode",
    );

    // run context
    const result = await execProcess({ cmd });
    if (result.success) {
      const [dir, stem] = dirAndStem(input);
      return join(dir, stem + ".pdf");
    } else {
      throw new Error();
    }
  };

  return texToPdfOutputRecipe(
    input,
    finalOutput,
    options,
    format,
    "context",
    pdfGenerator,
  );
}
