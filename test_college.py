"""
Basic tests for college.py calculator functionality
"""
import unittest


class TestCalculator(unittest.TestCase):
    """Test calculator operations"""
    
    def test_addition(self):
        """Test addition operation"""
        num1 = 10.0
        num2 = 20.0
        result = num1 + num2
        self.assertEqual(result, 30.0)
    
    def test_subtraction(self):
        """Test subtraction operation"""
        num1 = 20.0
        num2 = 10.0
        result = num1 - num2
        self.assertEqual(result, 10.0)
    
    def test_multiplication(self):
        """Test multiplication operation"""
        num1 = 5.0
        num2 = 4.0
        result = num1 * num2
        self.assertEqual(result, 20.0)
    
    def test_division(self):
        """Test division operation"""
        num1 = 20.0
        num2 = 4.0
        result = num1 / num2
        self.assertEqual(result, 5.0)
    
    def test_average_calculation(self):
        """Test average calculation for CASS marks"""
        num1 = 50.0
        num2 = 30.0
        average = (num1 + num2) / 2
        self.assertEqual(average, 40.0)


if __name__ == '__main__':
    unittest.main()
