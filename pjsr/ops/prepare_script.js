// A script of the Script menu works on the active image, so the one the assistant means has to
// be that. What the images look like now is what the report afterwards compares with.
if ( args.view )
{
   const view = ctx.view( args.view );
   if ( !view.isMainView )
      ctx.fail( "not_supported", "A script works on a whole image, and " + args.view + " is a preview. Pass its main view." );
   view.window.bringToFront();
   if ( ctx.activeView() != view.id )
      ctx.fail( "not_active", "PixInsight did not make " + view.id + " the active image, so the script would work on another one." );
}
return { startedOn: ctx.activeView(), images: ctx.imageDetails() };
