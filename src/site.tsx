import type { Content } from './types.js';

// 纯展示组件(无 fetch/无 state)——生成时用 react-dom/server 渲染成静态 HTML。
// 资源用相对路径(index.html 与 assets/ 同目录),电话/邮箱做成可点链接(利于本地 SEO 的 NAP)。
// formAction 传入时渲染询盘表单(纯 HTML form POST,零 JS;蜜罐字段防垃圾)。
// 移动端导航用 <details> 汉堡菜单——保持零 JS。
export function Site({ content: c, formAction }: { content: Content; formAction?: string }) {
  const tel = c.contacts.phone ? 'tel:' + c.contacts.phone.replace(/[^\d+]/g, '') : null;
  const mail = c.contacts.email ? 'mailto:' + c.contacts.email : null;
  const cta = tel || mail || (formAction ? '#quote' : '#contact');
  const year = new Date().getFullYear();
  const navLinks = (
    <>
      {c.services.length > 0 && <a href="#services">Services</a>}
      {c.about && <a href="#about">About</a>}
      {formAction && <a href="#quote">Get a Quote</a>}
      <a href="#contact">Contact</a>
    </>
  );
  return (
    <div className="sf">
      <header className="sf-header">
        <div className="sf-brand">
          {c.logo ? <img src={c.logo} alt={c.brandName} /> : <span className="sf-logo-text">{c.brandName}</span>}
        </div>
        <nav className="sf-nav" aria-label="Main">
          {navLinks}
          <a className="sf-btn" href={cta}>Get a Quote</a>
        </nav>
        <details className="sf-mnav">
          <summary aria-label="Menu">☰</summary>
          <div>{navLinks}</div>
        </details>
      </header>

      <main>
        <section className="sf-hero" style={c.hero ? { backgroundImage: `url(${c.hero})` } : undefined}>
          <div className="sf-hero-overlay" />
          <div className="sf-hero-inner">
            <h1>{c.brandName}</h1>
            {c.tagline && <p>{c.tagline}</p>}
            <a className="sf-btn sf-btn-lg" href={cta}>Get a Free Quote</a>
          </div>
        </section>

        {c.services.length > 0 && (
          <section id="services" className="sf-section">
            <h2>Our Services</h2>
            <div className="sf-grid">
              {c.services.map((s, i) => (
                <div className="sf-card" key={i}>
                  <div className="sf-card-bar" />
                  <h3>{s.title}</h3>
                  {s.description && <p>{s.description}</p>}
                </div>
              ))}
            </div>
          </section>
        )}

        {c.about && (
          <section id="about" className="sf-section sf-about">
            <h2>About {c.brandName}</h2>
            <p>{c.about}</p>
          </section>
        )}

        {formAction && (
          <section id="quote" className="sf-section sf-quote">
            <h2>Request a Quote</h2>
            <form className="sf-form" method="post" action={formAction}>
              <input type="text" name="_hp" className="sf-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <div className="sf-form-row">
                <input required name="name" placeholder="Your name" aria-label="Your name" />
                <input name="phone" placeholder="Phone" aria-label="Phone" />
              </div>
              <input type="email" name="email" placeholder="Email" aria-label="Email" />
              <textarea required name="message" rows={4} placeholder="How can we help?" aria-label="Message" />
              <button className="sf-btn sf-btn-lg" type="submit">Send Message</button>
            </form>
          </section>
        )}
      </main>

      <footer id="contact" className="sf-footer">
        <div className="sf-footer-inner">
          <div>
            <h3>{c.brandName}</h3>
          </div>
          <ul className="sf-contact">
            {c.contacts.address && <li><span aria-hidden="true">📍 </span>{c.contacts.address}</li>}
            {c.contacts.phone && <li><span aria-hidden="true">📞 </span><a href={tel!}>{c.contacts.phone}</a></li>}
            {c.contacts.email && <li><span aria-hidden="true">✉️ </span><a href={mail!}>{c.contacts.email}</a></li>}
            {c.contacts.hours && <li><span aria-hidden="true">🕒 </span>{c.contacts.hours}</li>}
          </ul>
        </div>
        <div className="sf-madeby">© {year} {c.brandName}. All rights reserved.</div>
      </footer>
    </div>
  );
}
