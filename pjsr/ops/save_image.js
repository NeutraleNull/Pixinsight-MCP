const view = ctx.view( args.view );
if ( !view.isMainView )
   ctx.fail( "not_supported", "Only main views can be saved." );

// saveAs makes the file the window's own, so a later Save in PixInsight goes there. For a lossy
// or 8-bit format that would replace the working image with a reduced one.
if ( !/\.(xisf|fits?|fts|tiff?)$/i.test( args.path ) )
   ctx.fail( "use_export", "save_image is for working files (XISF, FITS, TIFF). Use export_image for " + args.path + "." );

// The silent form of saveAs overwrites without asking, so existing files are checked here.
const createdFolder = ctx.prepareTarget( args.path, args.overwrite );

const window = view.window;
const previousPath = window.filePath;

// saveAs writes in place, so a failed save would leave a damaged file where a good one was.
// The old file steps aside until the new one is complete.
const backup = File.exists( args.path ) ? args.path + ".mcp-backup" : null;
if ( backup )
{
   if ( File.exists( backup ) )
      File.remove( backup );
   File.move( args.path, backup );
}
let saved = false;
try
{
   saved = window.saveAs( args.path, false/*queryOptions*/, false/*allowMessages*/, false/*strict*/, false/*verifyOverwrite*/ );
}
finally
{
   if ( backup )
   {
      if ( saved )
         File.remove( backup );
      else
      {
         if ( File.exists( args.path ) )
            File.remove( args.path );
         File.move( backup, args.path );
      }
   }
}
if ( !saved )
   ctx.fail( "save_failed", "PixInsight could not write " + args.path + ". See the console messages." );
ctx.clearSource( window );

const result = { view: view.id, path: args.path, ...ctx.storedMetadata( args.path ) };
// The image now belongs to another file than before, which matters if the user had opened it.
if ( previousPath.length > 0 && previousPath != args.path )
   result.previousPath = previousPath;
if ( createdFolder )
   result.createdFolder = createdFolder;
return result;
