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
if ( args.script )
{
   // PixInsight refuses to run a signed script that was changed after it was signed. The server
   // starts a script from inside a file of its own, where PixInsight does not look at the
   // signature of the script, so the same check is made here.
   const signed = File.exists( File.changeExtension( args.script, ".xsgn" ) );
   if ( signed )
   {
      const signature = Security.getScriptSignature( args.script );
      if ( !signature || signature.valid !== true )
         ctx.fail( "bad_signature", "The signature of this script is not valid for its file: the file was changed after it was signed, or the signature is damaged. PixInsight would not run it either." );
   }
}
return { startedOn: ctx.activeView(), images: ctx.imageDetails() };
