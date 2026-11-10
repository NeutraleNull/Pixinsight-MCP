// Writes a file without touching the window: it keeps its own path and modified state.
const view = ctx.view( args.view );
const window = view.window;
const image = view.image;

const extension = File.extractSuffix( args.path ).toLowerCase();
if ( extension.length == 0 )
   ctx.fail( "invalid_format", "The file name needs an extension: " + args.path );

let format = null;
try { format = new FileFormat( extension, false/*toRead*/, true/*toWrite*/ ); } catch ( error ) { /* reported below */ }
if ( format === null || format.isNull )
   ctx.fail( "invalid_format", "PixInsight cannot write " + extension + " files." );

const isLowDepth = /^\.jpe?g$/.test( extension );
const bits = args.bitsPerSample || (isLowDepth ? 8 : window.bitsPerSample);
// Without a word from the caller, 32 bits keep the kind of samples the image has: an integer
// file from a floating point image would be a silent change of its values.
const float = args.floatSample !== undefined ? args.floatSample : (bits == 64 || (bits == 32 && window.isFloatSample));

const supported = float ? ((bits == 32 && format.canStoreFloat) || (bits == 64 && format.canStoreDouble))
                        : ((bits == 8 && format.canStore8Bit) || (bits == 16 && format.canStore16Bit) || (bits == 32 && format.canStore32Bit));
if ( !supported )
   ctx.fail( "invalid_format", extension + " files cannot store " + bits + "-bit " + (float ? "floating point" : "integer") + " samples." );

function writeFile( path )
{
   const hints = (args.quality !== undefined) ? "quality " + args.quality + " " : "";
   const file = new FileFormatInstance( format );
   if ( !file.create( path, hints ) )
      ctx.fail( "export_failed", "PixInsight could not create " + path + "." );
   try
   {
      const description = new ImageDescription;
      description.bitsPerSample = bits;
      description.ieeefpSampleFormat = float;
      if ( !file.setOptions( description ) )
         ctx.fail( "export_failed", "PixInsight rejected the options for " + path + "." );
      file.setImageId( view.id );

      if ( format.canStoreKeywords )
         file.keywords = ctx.keywordsOf( view );
      if ( format.canStoreImageProperties )
         for ( const id of ctx.propertiesOf( view ) )
         {
            if ( window.mainView.propertyAttributes( id ) & PropertyAttribute.NotSerializable )
               continue;
            try
            {
               file.writeImageProperty( id, window.mainView.propertyValue( id ), window.mainView.propertyType( id ) );
            }
            catch ( error )
            {
               // Reserved properties cannot be stored; the format writes those it needs by itself.
            }
         }

      if ( !file.writeImage( image ) )
         ctx.fail( "export_failed", "PixInsight could not write " + path + ". See the console messages." );
      return { lossy: file.wasLossyWrite };
   }
   finally
   {
      file.close();
   }
}

const createdFolder = ctx.prepareTarget( args.path, args.overwrite );

// The target is only replaced once the new file is complete, so a failure keeps the old one.
// The temporary name keeps the extension, which is what selects the format.
const temporary = args.path.slice( 0, -extension.length ) + ".mcp-tmp" + extension;
let written;
try
{
   written = writeFile( temporary );
}
catch ( error )
{
   if ( File.exists( temporary ) )
      File.remove( temporary );
   throw error;
}

// Moving onto an existing file replaces it on Linux. Where it does not, the old file has to go
// first, and from then on the temporary file is the only copy, so it is never removed.
try
{
   File.move( temporary, args.path );
}
catch ( error )
{
   try
   {
      File.remove( args.path );
      File.move( temporary, args.path );
   }
   catch ( second )
   {
      ctx.fail( "export_failed", "The file was written as " + temporary + ", but could not be moved to " + args.path + ": " + (second.message || second) );
   }
}

return {
   view: view.fullId,
   path: args.path,
   bytes: (new FileInfo( args.path )).size,
   bitsPerSample: bits,
   floatSample: float,
   quality: args.quality,
   ...ctx.storedMetadata( args.path ),
   lossy: written.lossy,
   filePathOfWindow: window.filePath,
   ...(createdFolder ? { createdFolder } : {})
};
