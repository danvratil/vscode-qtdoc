#include "test.h"

/*!
    \class TestClass
    \since 1.0
    \inmodule Test

    \brief This class is used for testing QCH parser.

    Lorem ipsum dolor sit amet, consectetur adipiscing elit. Praesent id volutpat magna.
    Pellentesque iaculis molestie quam eget vulputate. Mauris eget mauris libero. Integer
    euismod sem purus, at consequat ligula accumsan vitae. Praesent ut arcu vel dolor
    laoreet pretium ac id mauris. Etiam fringilla imperdiet nisi sed pharetra.

    Fusce venenatis enim vitae lorem sagittis bibendum. Vivamus fringilla tellus nisl, at
    auctor dolor dictum in. Nullam id orci a nisl mollis hendrerit. Aliquam erat volutpat.
    Cras metus neque, lacinia feugiat euismod at, varius laoreet est.

    \section1 Example usage

    Omg, don't use this, it's for testing!
*/

/*!
    \fn void TestClass::testSignal()

    Test signal that is emitted when it feels like it.
*/

/*!
    \property TestClass::testProperty

    \brief The property that is used for testing.

    The value of this property is sometimes \c false and sometimes \c true.
*/
bool TestClass::testProperty() const
{
    return m_testProperty;
}

/*!
    \fn void TestClass::testPropertyChanged()

    Emitted when test property changed.

    \sa TestClass::testProperty
*/

/*!
    \fn void TestClass::setTestProperty(bool value)
    \brief Sets the value of test property to \a value.

    The new value of the test property can be either \c true or \c false.
*/
void TestClass::setTestProperty(bool value)
{
    if (m_testProperty == value)
        return;

    m_testProperty = value;
    Q_EMIT testPropertyChanged();
}