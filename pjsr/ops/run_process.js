// The server has checked the parameter names and enumeration constants before sending this job.
const id = args.processId;
const { meta, instance: P } = ctx.process( id );
const properties = new Map( meta.properties.map( p => [ p.id, p ] ) );
const names = Object.keys( args.params || {} );
const isEnum = name => ctx.isEnumeration( properties.get( name ) );

for ( const name of names )
{
   try
   {
      P[name] = isEnum( name ) ? globalThis[id][args.params[name]] : args.params[name];
   }
   catch ( error )
   {
      ctx.fail( "invalid_parameter_value", "" + (error.message || error) );
   }
}

// These ask in a modal dialog before they delete what a change of geometry invalidates: the
// astrometric solution, the previews and the mask. That holds up all jobs, and in automation mode
// the answer is No. So they go ahead, and the result says what was lost. Only for the processes
// this was measured on: what the parameter silences in others is not known.
const GEOMETRIC = [ "Crop", "DynamicCrop", "FastRotation", "Rotation", "Resample", "IntegerResample" ];
const goesAhead = GEOMETRIC.includes( id ) && properties.has( "noGUIMessages" ) && !names.includes( "noGUIMessages" );
if ( goesAhead )
   P.noGUIMessages = true;

if ( args.description )
   P.setDescription( args.description );

const POSITIONS = 512;

function snapshot( image, rect )
{
   return { width: rect.width, height: rect.height, channels: ctx.channelStats( image, rect ), samples: ctx.samples( image, rect, POSITIONS ) };
}

function currentState( view )
{
   return snapshot( view.image, new Rect( 0, 0, view.image.width, view.image.height ) );
}

// Each run on a preview starts again from the main image, whatever ran on the preview before.
function startingPoint( view )
{
   return view.isPreview ? snapshot( view.window.mainView.image, view.window.previewRect( view ) ) : currentState( view );
}

// Enough to tell whether a process changed the pixels, also for a process that reports
// success but quietly did nothing. Order statistics repeat exactly. The mean is a sum over
// parallel threads, so it may differ in its last digits, and stdDev differs even more.
// Mirrors and rotations keep all statistics, which is what the samples are for.
function sameImage( a, b )
{
   return a.width == b.width && a.height == b.height && a.channels.length == b.channels.length
       && a.channels.every( ( x, i ) =>
          {
             const y = b.channels[i];
             return x.min == y.min && x.max == y.max && x.median == y.median && x.mad == y.mad
                 && Math.abs( x.mean - y.mean ) <= 1e-10;
          } )
       && a.samples.every( ( sample, i ) => sample == b.samples[i] );
}

function execute( view )
{
   // Always with history: the user must be able to undo it, and without a swap file the
   // image does not even count as modified, so closing it later would lose the change silently.
   P.canExecuteOnOrThrow( view );
   return P.executeOn( view );
}

let maskWarning = null;

function executeMasked( view )
{
   const maskView = ctx.view( args.mask.view );
   const window = view.window;
   if ( !maskView.isMainView )
      ctx.fail( "invalid_mask", "A mask must be a main view, not a preview." );
   if ( maskView.window.mainView.id == window.mainView.id )
      ctx.fail( "invalid_mask", "An image cannot be its own mask." );
   if ( maskView.image.width != window.mainView.image.width || maskView.image.height != window.mainView.image.height )
      ctx.fail( "invalid_mask", "The mask must have the same dimensions as the image." );
   if ( !P.isMaskable( view, maskView.window ) )
      ctx.fail( "invalid_mask", id + " cannot run through a mask." );

   const previous = ctx.saveMask( window );
   window.mask = maskView.window;
   window.maskEnabled = true;
   window.maskInverted = args.mask.inverted === true;
   window.maskVisible = false;
   try
   {
      return execute( view );
   }
   finally
   {
      // Leaves the user's own mask setup exactly as it was.
      maskWarning = ctx.restoreMask( window, previous );
   }
}

function runIt( target )
{
   let executed;
   try
   {
      P.validateOrThrow();
      if ( target )
         executed = args.mask ? executeMasked( target ) : execute( target );
      else
      {
         P.canExecuteGlobalOrThrow();
         executed = P.executeGlobal();
      }
   }
   catch ( error )
   {
      if ( error.kind )
         throw error;
      if ( ctx.isAbort( error ) )
         ctx.fail( "aborted", "The process was aborted in PixInsight." );
      ctx.fail( "process_error", "" + (error.message || error) );
   }
   // Failures often surface only as a false return value, with the reason in the console.
   if ( !executed )
      ctx.fail( "process_failed", id + " reported a failure. See the console messages." );
}

// The values the process really ended up with. toSource rounds small values for display, so only
// enumerations come from there, as only the source gives their names. Floating point parameters
// are single precision, and the digits beyond that would only be noise.
function appliedValues()
{
   const source = P.toSource( "JavaScript", "P", 0, SourceCodeFlag.Minimal ).split( "\n" );
   const applied = {};
   for ( const name of names )
      if ( isEnum( name ) )
      {
         // A few enumerations are printed as numbers. Then the name that was passed has to do.
         const line = source.find( l => l.startsWith( "P." + name + " = " ) );
         const constant = line ? /= \w+\.(\w+);$/.exec( line ) : null;
         applied[name] = constant ? constant[1] : args.params[name];
      }
      else
      {
         const value = P[name];
         applied[name] = (typeof value == "number" && ctx.parameterType( properties.get( name ) ) == "float")
                           ? Number( value.toPrecision( 7 ) ) : value;
      }
   return applied;
}

// An output that still has its initial value was not set by this run, and something like
// isValid: false after a successful run only misleads.
function scalarOutputs()
{
   const initial = new globalThis[id];
   const outputs = {};
   for ( const property of meta.properties )
      if ( property.readOnly )
      {
         const value = P[property.id];
         const scalar = typeof value == "number" || typeof value == "boolean" || typeof value == "bigint" || (typeof value == "string" && value.length > 0);
         if ( scalar && value !== initial[property.id] )
            outputs[property.id] = value;
      }
   return outputs;
}

const windowsBefore = new Set( ImageWindow.windows.map( w => w.mainView.id ) );
const newViews = () => ImageWindow.windows.map( w => w.mainView.id ).filter( viewId => !windowsBefore.has( viewId ) );
const target = args.global ? null : ctx.view( args.view );
const window = target ? target.window : null;

// What undo cannot bring back: after a change of geometry, the images that used this one as their
// mask stay without it.
if ( goesAhead && window && ctx.maskedBy( window ).length > 0 )
   ctx.fail( "mask_in_use", args.view + " is the mask of " + ctx.maskedBy( window ).join( ", " ) + ". " + id + " would remove it there, and undo does not bring that back. Run it on a duplicate, or remove the mask there first." );

const pixelsBefore = target ? startingPoint( target ) : null;
const metadataBefore = target ? ctx.metadataOf( window ) : null;
const hadSolution = target ? window.hasAstrometricSolution : false;
const previewsBefore = target ? window.previews.length : 0;
// A mask the image already has is in effect unless this run brings its own.
const ownMask = (target && !args.mask && !window.mask.isNull && window.maskEnabled)
                  ? { view: window.mask.mainView.id, inverted: window.maskInverted } : null;

try
{
   runIt( target );
}
catch ( error )
{
   // A process can fail after it has made images, such as a background model.
   const left = newViews();
   if ( left.length > 0 )
      error.message += " The process left new images behind: " + left.join( ", " ) + ".";
   throw error;
}

const result = {
   process: id,
   target: args.global ? "global" : args.view,
   seconds: P.executionTime(),
   applied: appliedValues(),
   newViews: newViews(),
   outputs: scalarOutputs()
};
if ( args.mask )
   result.mask = { view: args.mask.view, inverted: args.mask.inverted === true };
if ( maskWarning )
   result.warning = maskWarning;
if ( target )
{
   const after = currentState( target );
   result.pixelsChanged = !sameImage( pixelsBefore, after );
   if ( ctx.metadataOf( window ) != metadataBefore )
      result.metadataChanged = true;
   if ( hadSolution && !window.hasAstrometricSolution )
      result.astrometryRemoved = true;
   if ( window.previews.length < previewsBefore )
      result.previewsRemoved = previewsBefore - window.previews.length;
   if ( ownMask )
   {
      if ( window.mask.isNull )
         result.maskRemoved = ownMask.view;
      else
         result.activeMask = ownMask;
   }
   if ( target.isPreview )
      result.startedFromMainImage = true;
   // To undo exactly this step later, and not one the user has made since.
   result.historyIndex = target.historyIndex;
   result.stats = after.channels;
}
return result;
