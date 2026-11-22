import LegalPage, { Section } from './legal/LegalPage';

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" updated="November 22, 2026">
      <p>These Terms of Service (the "Terms") govern your use of paintaround at paintaround.com (the "Service"), where you explore 360° photos of real places and draw on them live, together with whoever else is looking at the same place.</p>

      <Section n={1} heading="Agreement">
        <p>By using the Service, you agree to these Terms and to our <a href="/privacy">Privacy Policy</a>. If you don't agree, please don't use the Service.</p>
      </Section>

      <Section n={2} heading="How the Service works">
        <p>There are no accounts. Anyone can open a place and draw on it. Everyone viewing the same place sees each other's cursors and drawings as they happen. Drawings stay on a place after you leave, so others who come later can see them, and they appear in that place's preview pictures. They are kept in our server's memory, not saved permanently, and may be cleared at any time, for example when the server restarts.</p>
        <p>Each device gets a free amount of ink, which refills over time. Ink is a usage limit only: it can't be bought, sold or exchanged, and has no monetary value.</p>
      </Section>

      <Section n={3} heading="Acceptable use">
        <p>You agree not to use the Service to:</p>
        <ul>
          <li>draw or write anything hateful, harassing, sexually explicit, violent, threatening or illegal;</li>
          <li>post anyone's personal information, or impersonate anyone;</li>
          <li>spam, advertise, or flood a place with drawings;</li>
          <li>interfere with the Service or other people's use of it, for example by automating it, overloading it, or getting around its limits.</li>
        </ul>
      </Section>

      <Section n={4} heading="Your drawings">
        <p>You keep whatever rights you have in your drawings. By drawing, you let us show them to other people viewing that place, including in its preview pictures, for as long as they are kept. You can erase your own drawings; you can't erase anyone else's.</p>
        <p>You are responsible for what you draw. Other people may see it, and may take screenshots, while it is shown.</p>
      </Section>

      <Section n={5} heading="Enforcement">
        <p>We may remove drawings, limit ink, or block devices that break these Terms or put the Service or its users at risk, at our discretion and without notice.</p>
      </Section>

      <Section n={6} heading="Photos, maps and other content">
        <p>The 360° photos, map imagery and other content belong to their owners and are credited in the app with their licenses. Some photos are licensed under Creative Commons Attribution-ShareAlike (CC BY-SA): a drawing made on such a photo is an adaptation of it and is shared under the same license. The satellite map is provided by Esri and its partners. The pencil's paper texture is by David Revoy and is in the public domain (CC0).</p>
      </Section>

      <Section n={7} heading="Availability">
        <p>The Service is free and offered as is. We may change, pause or discontinue any part of it at any time, and places or features may come and go.</p>
      </Section>

      <Section n={8} heading="Disclaimer">
        <p>The Service is provided "as is" and "as available", without warranties of any kind, express or implied, including fitness for a particular purpose and non-infringement. We don't guarantee that it will be uninterrupted, secure or error-free, or that the photos and maps are accurate.</p>
      </Section>

      <Section n={9} heading="Limitation of liability">
        <p>To the fullest extent permitted by law, we are not liable for any indirect, incidental or consequential damages, or for any loss arising from your use of the Service or from drawings made by other people.</p>
      </Section>

      <Section n={10} heading="Changes to these Terms">
        <p>We may update these Terms from time to time. When we do, we'll change the date at the top of this page. Continuing to use the Service after a change means you accept the updated Terms.</p>
      </Section>

      <Section n={11} heading="Contact">
        <p>Questions about these Terms: <a href="mailto:markotsymbaluk@gmail.com">markotsymbaluk@gmail.com</a>.</p>
      </Section>
    </LegalPage>
  );
}
