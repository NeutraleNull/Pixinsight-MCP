const view = ctx.view( args.view );
const image = view.image;

function measure( region )
{
   const rect = ctx.rect( image, region );
   const result = {
      rect: region ? { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 } : null,
      channels: ctx.channelStats( image, rect )
   };
   if ( args.clipping )
   {
      // Counted directly, because the range clipping of Image also leaves out samples that equal
      // its upper bound, so saturated pixels would count as too dark. It would also mean changing
      // the state of the user's image.
      const { low, high } = args.clipping;
      const samples = new Float32Array( rect.width*rect.height );
      for ( const channel of result.channels )
      {
         image.getSamples( samples, rect, channel.channel );
         let below = 0, above = 0;
         for ( let i = 0; i < samples.length; ++i )
         {
            if ( samples[i] < low )
               ++below;
            if ( samples[i] > high )
               ++above;
         }
         if ( low !== undefined )
            channel.fractionBelowLow = below/samples.length;
         if ( high !== undefined )
            channel.fractionAboveHigh = above/samples.length;
      }
   }
   return result;
}

if ( args.rect && args.rects )
   ctx.fail( "invalid_arguments", "Pass either rect or rects, not both." );

const result = { view: view.fullId, width: image.width, height: image.height, color: image.isColor };
if ( args.rects )
   result.regions = args.rects.map( measure );
else
   Object.assign( result, measure( args.rect ) );
return result;
