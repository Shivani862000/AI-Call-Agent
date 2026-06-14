const fs = require('fs');
const PDFDocument = require('pdfkit');

try {
  const doc = new PDFDocument();
  doc.pipe(fs.createWriteStream('test-hindi.pdf'));

  const fontPath = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf';
  doc.registerFont('Hindi', fontPath);
  doc.font('Hindi').fontSize(20).text('बहुत दिक्कत हुई');

  doc.end();
  console.log('PDF generated successfully.');
} catch (e) {
  console.error('Error generating PDF:', e);
}
