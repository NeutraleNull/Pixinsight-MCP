const view = ctx.view( args.view );
const window = view.window;
const rect = ctx.rect( window.mainView.image, args.rect );

const preview = window.createPreview( rect, args.id || "" );

return {
   view: preview.fullId,
   rect: { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 },
   width: rect.width,
   height: rect.height
};
