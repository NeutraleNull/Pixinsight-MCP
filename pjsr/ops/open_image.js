if ( !/^(\/|[A-Za-z]:[\\/])/.test( args.path ) )
   ctx.fail( "invalid_path", "The path must be absolute: " + args.path );
if ( !File.exists( args.path ) )
   ctx.fail( "file_not_found", "No such file: " + args.path );

// In the GUI, reading a file can otherwise ask for format options in a modal dialog.
let opened;
try
{
   opened = ImageWindow.open( args.path, args.id || "", "non-interactive" );
}
catch ( error )
{
   ctx.fail( "open_failed", "PixInsight could not read " + args.path + ": " + (error.message || error) );
}
if ( !opened || opened.length == 0 )
   ctx.fail( "open_failed", "PixInsight could not read " + args.path + "." );

// Masters can carry extra images such as crop masks, and the first one is the actual image.
const wanted = args.allImages ? opened : opened.slice( 0, 1 );
const closedExtras = [];
for ( const w of opened.slice( wanted.length ) )
{
   closedExtras.push( w.mainView.id );
   w.forceClose();
}

// With the file's path on the window, a plain Save in PixInsight would overwrite a master with
// the processed image. A copy has no path. ImageWindow.open's copy argument keeps it, so it won't do.
const windows = [];
const skippedProperties = [];
if ( args.editOriginal )
   windows.push( ...wanted );
else
{
   // New windows stay hidden until they are shown, so nothing else would ever close them.
   const unfinished = new Set( wanted );
   try
   {
      for ( const w of wanted )
      {
         const id = w.mainView.id;
         const duplicated = ctx.duplicate( w.mainView, id + "_mcp_copy" );
         skippedProperties.push( ...duplicated.skippedProperties );
         w.forceClose();
         unfinished.delete( w );
         duplicated.window.mainView.id = id;
         ctx.markSource( duplicated.window, args.path );
         windows.push( duplicated.window );
      }
   }
   catch ( error )
   {
      for ( const w of [ ...unfinished, ...windows ] )
         w.forceClose();
      throw error;
   }
}

for ( const w of windows )
{
   w.show();
   w.zoomToOptimalFit( false, false );
}

const result = {
   views: windows.map( w => ( {
      view: w.mainView.id,
      width: w.mainView.image.width,
      height: w.mainView.image.height,
      channels: w.mainView.image.numberOfChannels,
      astrometry: w.hasAstrometricSolution,
      keywords: w.keywords.length
   } ) ),
   sourcePath: args.path,
   protectsSource: !args.editOriginal
};
if ( closedExtras.length )
   result.closedExtras = closedExtras;
if ( skippedProperties.length )
   result.skippedProperties = skippedProperties;
return result;
