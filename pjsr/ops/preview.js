// Works on a standalone copy: no window appears, the active window stays the same,
// and neither the pixels nor the history of the view are touched.
const view = ctx.view( args.view );
const source = view.image;
const maxSize = args.maxSize || 1024;
const rect = ctx.rect( source, args.crop );
if ( [ args.stf, args.stretchFrom, args.stretch ].filter( value => value !== undefined ).length > 1 )
   ctx.fail( "invalid_arguments", "Pass only one of stf, stretchFrom and stretch." );

const whole = image => new Rect( 0, 0, image.width, image.height );

// An image that is almost empty, such as a star layer, has no background to go by: the usual
// automatic stretch then turns residues into bright patches and stars into blobs.
function isSparse( image )
{
   return image.median( whole( image ), 0, image.numberOfChannels - 1 ) < 1e-6;
}

// For such an image the brightest pixels decide: the level that only one pixel in 200 exceeds
// becomes mid gray, in all channels alike. A star layer that is already stretched has that level
// near mid gray, and then comes out almost as it is.
function sparseStretch( image )
{
   const step = Math.max( 1, Math.floor( Math.sqrt( image.width*image.height/400000 ) ) );
   const row = new Float32Array( image.width );
   const brightest = [];
   for ( let c = 0; c < image.numberOfNominalChannels; ++c )
      for ( let y = 0, i = 0; y < image.height; y += step )
      {
         image.getSamples( row, new Rect( 0, y, image.width, y + 1 ), c );
         for ( let x = 0; x < image.width; x += step, ++i )
            brightest[i] = Math.max( brightest[i] || 0, row[x] );
      }
   const sorted = Float32Array.from( brightest ).sort();
   const level = [ 0.995, 0.999, 0.9999 ].map( f => sorted[Math.floor( f*sorted.length )] ).find( value => value > 0 )
              || sorted[sorted.length - 1];
   const midtones = Math.min( 0.5, level || 0.5 );
   return [ 0, 1, 2 ].map( () => [ midtones, 0, 1, 0, 1 ] ).concat( [ [ 0.5, 0, 1, 0, 1 ] ] );
}

function autoStretch( image, linked )
{
   if ( isSparse( image ) )
      return sparseStretch( image );
   if ( !linked )
      return image.computeAutoStretch();
   const center = [], sigma = [];
   for ( let c = 0; c < image.numberOfNominalChannels; ++c )
   {
      const median = image.median( whole( image ), c, c );
      center.push( median );
      sigma.push( 1.4826*image.MAD( median, whole( image ), c, c ) );
   }
   return image.computeAutoStretch( center, sigma, -2.8, 0.25, true );
}

// A fixed stretch makes previews comparable. An automatic one adapts to each image, so the same
// data can look different.
let stf = null, mode = "none", note;
if ( args.stf )
{
   stf = args.stf;
   mode = "fixed";
}
else if ( args.stretchFrom )
{
   stf = autoStretch( ctx.view( args.stretchFrom ).image, args.linked === true );
   mode = "from " + args.stretchFrom;
}
else if ( (args.stretch || "auto") == "auto" )
{
   stf = autoStretch( source, args.linked === true );
   if ( isSparse( source ) )
   {
      mode = "auto sparse";
      note = "Almost all pixels are near zero, as in a star layer, so the stretch follows the brightest pixels instead of the background. It shows stars, and hides faint residues.";
   }
   else
      mode = args.linked === true ? "auto linked" : "auto";
}

const copy = new Image;
let path, width, height;
try
{
   copy.assign( source, rect );
   if ( stf )
      copy.applyDisplayFunction( stf );

   // Rendering at a reduced zoom is much faster than scaling a full-size bitmap.
   const largest = Math.max( copy.width, copy.height );
   const reduction = Math.floor( largest/maxSize );
   let bitmap = copy.render( (reduction >= 2) ? -reduction : 1, false, false );
   const rendered = Math.max( bitmap.width, bitmap.height );
   if ( rendered > maxSize )
      bitmap = bitmap.scaled( maxSize/rendered );

   path = ctx.jobDir + "/preview.jpg";
   bitmap.save( path, 85 );
   width = bitmap.width;
   height = bitmap.height;
}
finally
{
   copy.free();
}

const result = {
   view: view.fullId,
   sourceWidth: source.width,
   sourceHeight: source.height,
   crop: args.crop ? { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 } : null,
   width,
   height,
   stretch: mode,
   imagePath: path
};
if ( stf )
   result.stf = stf;
if ( note )
   result.note = note;
return result;
