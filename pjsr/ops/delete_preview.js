const view = ctx.view( args.view );
if ( !view.isPreview )
   ctx.fail( "not_a_preview", view.fullId + " is not a preview." );

const id = view.fullId;
view.window.deletePreview( view );

return { deleted: id };
