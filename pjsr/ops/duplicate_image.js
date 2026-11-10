const view = ctx.view( args.view );
const result = ctx.duplicate( view, args.id, args.rect );

// Always shown: a window that was never shown stays invisible, and no tool could bring it up.
result.window.show();
result.window.zoomToOptimalFit( false, false );

const image = result.window.mainView.image;
return {
   view: result.window.mainView.id,
   source: view.fullId,
   width: image.width,
   height: image.height,
   keywords: result.keywords,
   properties: result.properties,
   skippedProperties: result.skippedProperties,
   astrometry: result.astrometry
};
