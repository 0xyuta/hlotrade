declare module "lz4js" {
  export function decompress(src: Uint8Array, maxSize?: number): Uint8Array | number[];
  export function compress(src: Uint8Array): Uint8Array | number[];
  const lz4: { decompress: typeof decompress; compress: typeof compress };
  export default lz4;
}
