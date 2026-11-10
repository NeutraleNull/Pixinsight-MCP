// Helpers shared by the operations. Evaluated by the runner, which passes in its context.
( function( ctx )
{
   const SOURCE_PROPERTY = "MCP:SourcePath";
   // These describe the whole image, so they are wrong for a part of it.
   const WHOLE_IMAGE_KEYWORD = /^(WCSAXES|RADESYS|EQUINOX|LONPOLE|LATPOLE|CTYPE\d|CUNIT\d|CRPIX\d|CRVAL\d|CDELT\d|CROTA\d|CD\d_\d|PC\d_\d|PV\d_\d+|(A|B|AP|BP)_\w+)$/;
   const WHOLE_IMAGE_PROPERTY = /^PCL:AstrometricSolution:/;

   ctx.view = function( id )
   {
      let view = null;
      try { view = View.viewById( id ); } catch ( e ) { ctx.fail( "unknown_view", "Invalid view identifier: " + id ); }
      if ( view === null || view.isNull )
         ctx.fail( "unknown_view", "No view named " + id + ". Use list_images." );
      return view;
   };

   ctx.process = function( id )
   {
      if ( !MetaObject.externalObjects.includes( id ) )
         ctx.fail( "unknown_process", "No installed process named " + id + ". Use list_processes." );
      return { meta: MetaObject.objectById( id ), instance: new globalThis[id] };
   };

   ctx.categories = function( instance )
   {
      return instance.processCategory().split( "," ).map( c => c.trim() ).filter( c => c.length > 0 );
   };

   // The first word of a parameter's description. The core types enumerations as plain "int",
   // while numeric parameters are int32, uint32 and so on.
   ctx.parameterType = function( property )
   {
      return property.description.split( " " )[0];
   };

   ctx.isEnumeration = function( property )
   {
      return ctx.parameterType( property ) == "int";
   };

   // How PixInsight reports that the user pressed Abort.
   ctx.isAbort = function( error )
   {
      // Anything can be thrown, also null.
      return error != null && /Process aborted/.test( "" + (error.message || error) );
   };

   // Clamps a { x0, y0, x1, y1 } region to the image. Without a region, the whole image.
   ctx.rect = function( image, region )
   {
      if ( !region )
         return new Rect( 0, 0, image.width, image.height );
      const x0 = Math.max( 0, region.x0 ), y0 = Math.max( 0, region.y0 );
      const x1 = Math.min( image.width, region.x1 ), y1 = Math.min( image.height, region.y1 );
      if ( x1 <= x0 || y1 <= y0 )
         ctx.fail( "invalid_region", "The region does not overlap the " + image.width + "x" + image.height + " image." );
      return new Rect( x0, y0, x1, y1 );
   };

   ctx.channelStats = function( image, rect )
   {
      const channels = [];
      for ( let c = 0; c < image.numberOfChannels; ++c )
      {
         const median = image.median( rect, c, c );
         channels.push( {
            channel: c,
            min: image.minimum( rect, c, c ),
            max: image.maximum( rect, c, c ),
            mean: image.mean( rect, c, c ),
            median,
            mad: image.MAD( median, rect, c, c )
         } );
      }
      return channels;
   };

   ctx.saveMask = function( window )
   {
      return { mask: window.mask, enabled: window.maskEnabled, inverted: window.maskInverted, visible: window.maskVisible };
   };

   // Returns a warning if the mask cannot go back, because a crop in the history changed the size
   // of the image, for example. No mask is then safer than one that nobody asked for.
   ctx.restoreMask = function( window, state )
   {
      try
      {
         if ( state.mask.isNull )
            window.removeMask();
         else
            window.mask = state.mask;
      }
      catch ( error )
      {
         window.removeMask();
         return "The mask " + state.mask.mainView.id + " no longer fits this image, so the image has no mask now.";
      }
      window.maskEnabled = state.enabled;
      window.maskInverted = state.inverted;
      window.maskVisible = state.visible;
      return null;
   };

   // PixInsight stores the active mask with each history state and brings it back on undo. A mask
   // that was only meant for one run would then silently affect every later process.
   // Returns a warning, if there is one, because the move itself has already happened.
   ctx.moveInHistory = function( view, index )
   {
      const state = ctx.saveMask( view.window );
      view.historyIndex = index;
      return ctx.restoreMask( view.window, state );
   };

   ctx.sourcePath = function( window )
   {
      const view = window.mainView;
      return view.properties.includes( SOURCE_PROPERTY ) ? view.propertyValue( SOURCE_PROPERTY ) : null;
   };

   // isModified alone misses new images, which report false until something changes them,
   // although closing one loses it. A protected copy still matches its file until it is processed.
   ctx.isUnsaved = function( window )
   {
      if ( window.isModified )
         return true;
      if ( !window.isNew && window.filePath.length > 0 )
         return false;
      // Undone steps count too: closing loses them, and isModified is false again after an undo.
      return ctx.sourcePath( window ) === null || window.mainView.canGoBackward || window.mainView.canGoForward;
   };

   // The windows that use this one as their mask.
   ctx.maskedBy = function( window )
   {
      const id = window.mainView.id;
      return ImageWindow.windows.filter( w => !w.mask.isNull && w.mask.mainView.id == id ).map( w => w.mainView.id );
   };

   // Everything a tool has to check before it writes a file the caller named. Creates the folder
   // if needed, because no tool can do that, and returns it in that case.
   ctx.prepareTarget = function( path, overwrite )
   {
      if ( !/^(\/|[A-Za-z]:[\\/])/.test( path ) )
         ctx.fail( "invalid_path", "The path must be absolute: " + path );
      // A protected copy exists so that its source cannot be overwritten by accident.
      for ( const window of ImageWindow.windows )
         if ( ctx.sourcePath( window ) == path )
            ctx.fail( "protected_source", path + " is the file that " + window.mainView.id + " was opened from. Choose another name. To change the file itself, open it with editOriginal." );
      if ( File.exists( path ) && !overwrite )
         ctx.fail( "file_exists", path + " already exists. Choose another name, or pass overwrite: true if the user wants this file replaced." );
      const folder = File.extractDrive( path ) + File.extractDirectory( path );
      if ( File.directoryExists( folder ) )
         return null;
      File.createDirectory( folder, true/*createIntermediateDirectories*/ );
      return folder;
   };

   // For the server, which remembers it: after a crash nothing can be asked any more.
   ctx.imageStates = function()
   {
      return ImageWindow.windows.map( window => ( { view: window.mainView.id, unsaved: ctx.isUnsaved( window ) } ) );
   };

   // The pixel values at some positions spread over a region, channel by channel. An irregular
   // sequence, because a regular grid can map onto itself under a mirror.
   ctx.samples = function( image, rect, positions )
   {
      const samples = [];
      for ( let c = 0; c < image.numberOfChannels; ++c )
         for ( let i = 0; i < positions; ++i )
         {
            const x = rect.x0 + Math.floor( ((0.5 + i * 0.7548776662) % 1) * rect.width );
            const y = rect.y0 + Math.floor( ((0.5 + i * 0.5698402910) % 1) * rect.height );
            samples.push( image.sample( x, y, c ) );
         }
      return samples;
   };

   // Keywords with their values, and properties with the start of theirs, as one text to compare.
   // A step that only corrects a value, such as a second plate solution, has changed the metadata too.
   ctx.metadataOf = function( window )
   {
      const view = window.mainView;
      return JSON.stringify( [
         window.keywords.map( keyword => [ keyword.name, keyword.value ] ),
         view.properties.map( id => [ id, ("" + view.propertyValue( id )).substring( 0, 64 ) ] )
      ] );
   };

   const FINGERPRINT_POSITIONS = 128;

   // The images as seen from outside, to tell afterwards what a script or code did to them.
   ctx.imageDetails = function()
   {
      return ImageWindow.windows.map( window =>
      {
         const view = window.mainView;
         return {
            view: view.id,
            historyIndex: view.historyIndex,
            width: view.image.width,
            height: view.image.height,
            channels: view.image.numberOfChannels,
            astrometry: window.hasAstrometricSolution,
            previews: window.previews.length,
            metadata: ctx.metadataOf( window ),
            // Joined, so that a sample that is not a number still compares as equal to itself.
            fingerprint: ctx.samples( view.image, new Rect( 0, 0, view.image.width, view.image.height ), FINGERPRINT_POSITIONS ).join( "," )
         };
      } );
   };

   // What is different from an earlier ctx.imageDetails(). Whoever started a script or ran code
   // has to learn all of it, because none of it shows in a return value.
   ctx.changesSince = function( before )
   {
      const earlier = new Map( before.map( image => [ image.view, image ] ) );
      const now = ctx.imageDetails();
      const changedViews = [];
      for ( const image of now )
      {
         const was = earlier.get( image.view );
         if ( !was )
            continue;
         const what = [];
         if ( image.historyIndex != was.historyIndex )
            what.push( "history" );
         if ( image.width != was.width || image.height != was.height || image.channels != was.channels )
            what.push( "geometry" );
         if ( image.astrometry != was.astrometry )
            what.push( "astrometry" );
         if ( image.previews != was.previews )
            what.push( "previews" );
         if ( image.metadata != was.metadata )
            what.push( "metadata" );
         // Other pixels at the same place in the history: usually a change that left no step
         // there. It can also be an undo followed by a new step, which this cannot tell apart.
         const samePlace = image.historyIndex == was.historyIndex && image.fingerprint != was.fingerprint;
         if ( samePlace )
            what.push( "pixels" );
         if ( what.length > 0 )
         {
            const change = { view: image.view, changed: what, historyIndex: image.historyIndex, steps: image.historyIndex - was.historyIndex };
            if ( samePlace )
               change.note = "The pixels differ, and the history is at the same place. Usually that is a change with no step in the history, which undo cannot take back.";
            changedViews.push( change );
         }
      }
      const present = new Set( now.map( image => image.view ) );
      return {
         newViews: now.filter( image => !earlier.has( image.view ) ).map( image => image.view ),
         closedViews: before.filter( image => !present.has( image.view ) ).map( image => image.view ),
         changedViews
      };
   };

   ctx.activeView = function()
   {
      const active = ImageWindow.activeWindow;
      return (active && !active.isNull) ? active.mainView.id : null;
   };

   ctx.keywordsOf = function( view, whole = view.isMainView )
   {
      const keywords = view.window.keywords;
      return whole ? keywords : keywords.filter( keyword => !WHOLE_IMAGE_KEYWORD.test( keyword.name ) );
   };

   ctx.propertiesOf = function( view, whole = view.isMainView )
   {
      return view.window.mainView.properties.filter( id =>
         id != SOURCE_PROPERTY && (whole || !WHOLE_IMAGE_PROPERTY.test( id )) );
   };

   // What a file really holds. A format can accept properties while writing and still not store
   // them: JPEG takes them all and keeps none. Null if the file cannot be read back.
   ctx.storedMetadata = function( path )
   {
      const file = new FileFormatInstance( new FileFormat( File.extractSuffix( path ), true/*toRead*/, false/*toWrite*/ ) );
      try
      {
         file.open( path, "" );
      }
      catch ( error )
      {
         return null;
      }
      try
      {
         const properties = file.imageProperties.map( property => property[0] );
         const keywords = file.keywords.map( keyword => keyword.name );
         return {
            keywords: keywords.length,
            properties: properties.length,
            astrometry: keywords.includes( "CRVAL1" ) || properties.some( id => WHOLE_IMAGE_PROPERTY.test( id ) )
         };
      }
      finally
      {
         file.close();
      }
   };

   // A new window without a file path, with the metadata of the source. PixelMath's
   // createNewImage drops all of it, including the astrometric solution.
   ctx.duplicate = function( view, id, region )
   {
      const source = view.window;
      const image = view.image;
      const rect = ctx.rect( image, region );
      const whole = view.isMainView && !region;
      const copy = new ImageWindow( rect.width, rect.height, image.numberOfChannels,
                                    source.bitsPerSample, source.isFloatSample, image.isColor, id || view.id + "_copy" );
      try
      {
         const target = copy.mainView;
         target.beginProcess( UndoFlag.NoSwapFile );
         target.image.assign( image, rect );
         target.endProcess();

         copy.keywords = ctx.keywordsOf( view, whole );
         copy.rgbWorkingSpace = source.rgbWorkingSpace;
         const skipped = [];
         let copied = 0;
         for ( const property of ctx.propertiesOf( view, whole ) )
         {
            try
            {
               target.setPropertyValue( property, source.mainView.propertyValue( property ),
                                        source.mainView.propertyType( property ), source.mainView.propertyAttributes( property ) );
               ++copied;
            }
            catch ( error )
            {
               skipped.push( property );
            }
         }
         let astrometry = false;
         if ( whole && source.hasAstrometricSolution )
         {
            copy.copyAstrometricSolution( source );
            astrometry = copy.hasAstrometricSolution;
         }
         target.stf = source.mainView.stf;
         return { window: copy, keywords: copy.keywords.length, properties: copied, skippedProperties: skipped, astrometry };
      }
      catch ( error )
      {
         copy.forceClose();
         throw error;
      }
   };

   // Permanent, because any other property is dropped as soon as a process changes the image,
   // and with it the protection of the file. Not serializable, so that it never gets into a file.
   ctx.markSource = function( window, path )
   {
      window.mainView.setPropertyValue( SOURCE_PROPERTY, path, PropertyType.String,
                                        PropertyAttribute.NotSerializable | PropertyAttribute.Permanent );
   };

   ctx.clearSource = function( window )
   {
      if ( ctx.sourcePath( window ) !== null )
         window.mainView.deleteProperty( SOURCE_PROPERTY );
   };
} )
