/** Service: PDF Invoice Generator */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

/** Generate PDF Invoice Buffer */
function generateInvoicePdfBuffer(invoice, customer, settings = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: `Invoice #INV-${String(invoice.id).padStart(4, '0')}`,
          Author: settings.company_header || 'ZenRadius',
          Subject: 'Invoice Pembayaran Internet'
        }
      });

      const buffers = [];
      doc.on('data', b => buffers.push(b));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', err => reject(err));

      const companyName = settings.company_header || 'ZenRadius';
      const companyAddress = settings.company_address || 'Pusat Layanan Internet Terpercaya';
      const companyPhone = (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0)
        ? '+' + settings.whatsapp_admin_numbers[0]
        : (settings.company_phone || '-');
      const managerName = settings.company_manager || 'Admin Pusat';

      const year = new Date().getFullYear();
      const invNo = `INV-${String(invoice.id).padStart(4, '0')}-${year}`;
      const isPaid = (invoice.status === 'paid');

      const mns = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
      const periodStr = `${mns[(invoice.period_month || 1) - 1]} ${invoice.period_year || year}`;

      const primaryColor = '#4f46e5';
      const accentColor = '#06b6d4';
      const darkText = '#0f172a';
      const mutedText = '#64748b';
      const lightBg = '#f8fafc';
      const borderColor = '#e2e8f0';
      const statusColor = isPaid ? '#10b981' : '#ef4444';
      const statusText = isPaid ? 'LUNAS' : 'BELUM BAYAR';

      doc.rect(0, 0, 595.28, 8).fill(primaryColor);

      let y = 35;

      const logoPath = path.join(__dirname, '../public/img/logo.png');
      let logoDrawn = false;
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, 40, y, { fit: [140, 42] });
          logoDrawn = true;
        } catch (e) {}
      }

      if (!logoDrawn) {

        doc.circle(60, y + 20, 20).fill(primaryColor);
        doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold')
           .text(companyName.charAt(0).toUpperCase(), 40, y + 12, { width: 40, align: 'center' });
      }

      const compX = logoDrawn ? 190 : 90;
      doc.fillColor(darkText).fontSize(16).font('Helvetica-Bold').text(companyName, compX, y);
      doc.fillColor(mutedText).fontSize(9).font('Helvetica').text(companyAddress, compX, y + 20);
      doc.fillColor(mutedText).fontSize(9).text(`Telp/WA: ${companyPhone}`, compX, y + 33);

      doc.fillColor(primaryColor).fontSize(20).font('Helvetica-Bold').text('INVOICE', 380, y, { align: 'right', width: 175 });
      doc.fillColor(darkText).fontSize(11).font('Helvetica-Bold').text(`# ${invNo}`, 380, y + 24, { align: 'right', width: 175 });

      doc.roundedRect(475, y + 42, 80, 20, 10).fillAndStroke(isPaid ? '#ecfdf5' : '#fef2f2', isPaid ? '#a7f3d0' : '#fecaca');
      doc.fillColor(statusColor).fontSize(9).font('Helvetica-Bold').text(statusText, 475, y + 47, { width: 80, align: 'center' });

      y = 95;
      doc.moveTo(40, y).lineTo(555, y).dash(4, { space: 3 }).strokeColor(borderColor).stroke().undash();

      y += 15;

      doc.roundedRect(40, y, 250, 75, 6).fillAndStroke(lightBg, borderColor);
      doc.fillColor(mutedText).fontSize(8).font('Helvetica-Bold').text('DITAGIHKAN KEPADA', 52, y + 10);
      doc.fillColor(darkText).fontSize(12).font('Helvetica-Bold').text(customer.name || '-', 52, y + 22);

      let custMeta = [];
      if (customer.phone) custMeta.push(`HP: ${customer.phone}`);
      if (customer.pppoe_username) custMeta.push(`PPPoE: ${customer.pppoe_username}`);
      doc.fillColor(mutedText).fontSize(9).font('Helvetica').text(custMeta.join('  |  '), 52, y + 38, { width: 226 });
      if (customer.address) {
        doc.fillColor(mutedText).fontSize(8.5).text(`Alamat: ${customer.address}`, 52, y + 52, { width: 226, height: 16, lineBreak: false });
      }

      doc.roundedRect(305, y, 250, 75, 6).fillAndStroke(lightBg, borderColor);
      doc.fillColor(mutedText).fontSize(8).font('Helvetica-Bold').text('INFORMASI TRANSAKSI', 317, y + 10);

      doc.fillColor(mutedText).fontSize(8.5).font('Helvetica').text('Tanggal:', 317, y + 24);
      const paidDateStr = isPaid && invoice.paid_at ? String(invoice.paid_at).slice(0, 10) : new Date().toISOString().slice(0, 10);
      doc.fillColor(darkText).fontSize(9).font('Helvetica-Bold').text(paidDateStr, 370, y + 24);

      doc.fillColor(mutedText).fontSize(8.5).font('Helvetica').text('Periode:', 317, y + 38);
      doc.fillColor(darkText).fontSize(9).font('Helvetica-Bold').text(periodStr, 370, y + 38);

      doc.fillColor(mutedText).fontSize(8.5).font('Helvetica').text('Kasir:', 317, y + 52);
      doc.fillColor(darkText).fontSize(9).font('Helvetica-Bold').text(invoice.paid_by_name || 'Sistem', 370, y + 52);

      y += 90;
      doc.fillColor(mutedText).fontSize(8).font('Helvetica-Bold').text('RINCIAN LAYANAN', 40, y);
      y += 12;

      doc.roundedRect(40, y, 515, 22, 4).fill(lightBg);
      doc.rect(40, y, 515, 22).strokeColor(borderColor).stroke();

      doc.fillColor(mutedText).fontSize(8.5).font('Helvetica-Bold');
      doc.text('#', 50, y + 6, { width: 30 });
      doc.text('Deskripsi Layanan', 80, y + 6, { width: 280 });
      doc.text('Periode', 360, y + 6, { width: 90 });
      doc.text('Jumlah', 460, y + 6, { width: 85, align: 'right' });

      y += 22;

      doc.rect(40, y, 515, 36).strokeColor(borderColor).stroke();
      doc.fillColor(darkText).fontSize(9.5).font('Helvetica-Bold').text('01', 50, y + 11);

      const pkgName = customer.package_name || 'Paket Internet Broadband';
      doc.fillColor(darkText).fontSize(9.5).font('Helvetica-Bold').text(`Layanan Internet — ${pkgName}`, 80, y + 6);
      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(`Langganan bulanan internet high-speed`, 80, y + 20);

      doc.fillColor(darkText).fontSize(9).font('Helvetica').text(periodStr, 360, y + 11);

      const amountStr = `Rp ${Number(invoice.amount || 0).toLocaleString('id-ID')}`;
      doc.fillColor(darkText).fontSize(10).font('Helvetica-Bold').text(amountStr, 460, y + 11, { width: 85, align: 'right' });

      doc.save();
      doc.fillColor(isPaid ? '#10b981' : '#ef4444').opacity(0.06).fontSize(54).font('Helvetica-Bold');
      doc.rotate(-20, { origin: [297, y + 30] });
      doc.text(isPaid ? 'LUNAS' : 'TAGIHAN', 150, y, { width: 300, align: 'center' });
      doc.restore();

      y += 48;

      doc.roundedRect(40, y, 300, 52, 6).fillAndStroke(lightBg, borderColor);
      doc.fillColor(darkText).fontSize(8.5).font('Helvetica-Bold').text('Catatan Pembayaran:', 50, y + 8);
      const noteText = invoice.notes || 'Terima kasih telah berlangganan layanan internet kami. Simpan bukti ini untuk keperluan administrasi.';
      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(noteText, 50, y + 22, { width: 280, height: 24 });

      doc.roundedRect(355, y, 200, 52, 6).fillAndStroke(primaryColor, primaryColor);
      doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold').text('TOTAL BAYAR', 368, y + 12);
      doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold').text(amountStr, 368, y + 26, { width: 175, align: 'right' });

      y += 75;
      doc.moveTo(40, y).lineTo(555, y).strokeColor(borderColor).stroke();
      y += 12;

      doc.fillColor(darkText).fontSize(9).font('Helvetica-Bold').text(companyName, 40, y);
      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(companyAddress, 40, y + 13);
      doc.fillColor(mutedText).fontSize(7.5).text(`Dicetak Otomatis pada ${new Date().toLocaleString('id-ID')}`, 40, y + 25);

      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('Hormat Kami,', 440, y, { width: 115, align: 'center' });
      doc.moveTo(440, y + 36).lineTo(555, y + 36).strokeColor(darkText).stroke();
      doc.fillColor(darkText).fontSize(9).font('Helvetica-Bold').text(managerName, 440, y + 40, { width: 115, align: 'center' });
      doc.fillColor(mutedText).fontSize(7.5).font('Helvetica').text('Manajer Operasional', 440, y + 51, { width: 115, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateInvoicePdfBuffer
};
