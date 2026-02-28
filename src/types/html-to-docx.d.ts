declare module "html-to-docx" {
  export type HtmlToDocxOptions = {
    title?: string;
    creator?: string;
    [key: string]: unknown;
  };

  export default function HTMLtoDOCX(
    html: string,
    footer?: unknown,
    options?: HtmlToDocxOptions
  ): Promise<Buffer | ArrayBuffer>;
}

